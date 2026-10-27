import { SystemInfo, DiskHealthReport, DriveHealth, TemperaturesReport, ChipTemperatures } from '../types.js';
import { promises as fs } from 'fs';
import os from 'os';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { getProxmoxHostStatus } from './proxmox.js';

const execFile = promisify(execFileCb);

export async function getSystemInfo(): Promise<SystemInfo> {
  const hostname = os.hostname();
  const uptimeHours = parseFloat((os.uptime() / 3600).toFixed(2));

  // CPU usage - average over 1 second
  const cpuPercent = await getCPUUsage();

  // Memory
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const memoryUsedGB = parseFloat((usedMemory / (1024 ** 3)).toFixed(2));
  const memoryTotalGB = parseFloat((totalMemory / (1024 ** 3)).toFixed(2));
  const memoryPercent = parseFloat(((usedMemory / totalMemory) * 100).toFixed(2));

  // Disk usage for root filesystem
  const diskStats = await getDiskUsage('/');

  // Best-effort Proxmox host metrics; null when unconfigured or unreachable
  let proxmoxHost = null;
  try {
    proxmoxHost = await getProxmoxHostStatus();
  } catch (e) {
    console.error('[System] Could not get Proxmox host status:', (e as Error).message);
  }

  return {
    hostname,
    uptime_hours: uptimeHours,
    cpu_percent: cpuPercent,
    memory_used_gb: memoryUsedGB,
    memory_total_gb: memoryTotalGB,
    memory_percent: memoryPercent,
    disk_used_gb: diskStats.usedGB,
    disk_total_gb: diskStats.totalGB,
    disk_percent: diskStats.percent,
    scope: 'local',
    proxmox_host: proxmoxHost,
  };
}

const BLOCK_DEVICE_RE = /^(sd[a-z]+|nvme\d+n\d+)$/;

async function listBlockDevices(): Promise<string[]> {
  try {
    const entries = await fs.readdir('/sys/block');
    return entries.filter((name) => BLOCK_DEVICE_RE.test(name)).sort();
  } catch {
    return [];
  }
}

export async function getDiskHealth(): Promise<DiskHealthReport> {
  const devices = await listBlockDevices();

  const probes = devices.map(async (name): Promise<DriveHealth> => {
    const device = `/dev/${name}`;
    let stdout: string;

    try {
      const result = await execFile('smartctl', ['-H', '-A', '-i', device], { timeout: 20000 });
      stdout = result.stdout;
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number };

      // Binary not installed at all - abort the whole scan
      if (err.code === 'ENOENT') {
        throw new Error('smartctl not installed');
      }

      // smartctl exits non-zero for permission issues but may still print a usable health report
      if (err.stdout && /(overall-health self-assessment test result|SMART Health Status)/i.test(err.stdout)) {
        stdout = err.stdout;
      } else {
        return { device, error: firstSmartctlLine(`${err.stdout || ''}${err.stderr || ''}`) || `smartctl exited with code ${err.code}` };
      }
    }

    return { device, ...parseSmartOutput(stdout) };
  });

  try {
    const drives = await Promise.all(probes);
    return { drives };
  } catch (error) {
    if ((error as Error).message === 'smartctl not installed') {
      return { drives: [], error: 'smartctl not installed', devices };
    }
    throw error;
  }
}

function firstSmartctlLine(output: string): string {
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || /^smartctl \d/i.test(trimmed) || /^copyright/i.test(trimmed)) continue;
    return trimmed;
  }
  return '';
}

function parseSmartOutput(output: string): Omit<DriveHealth, 'device'> {
  const info: Omit<DriveHealth, 'device'> = {};
  const attrRaw: Record<string, number> = {};

  for (const line of output.split('\n')) {
    const trimmed = line.trim();

    // Overall health (ATA: "SMART overall-health self-assessment test result: PASSED", NVMe: "SMART Health Status: OK")
    const health = trimmed.match(/(?:overall-health self-assessment test result|SMART Health Status):\s*(.+)$/i);
    if (health) {
      const value = health[1].trim();
      info.smart_status = /^(passed|ok)$/i.test(value) ? 'PASSED' : value.toUpperCase();
      continue;
    }

    // -i / NVMe key-value lines
    const kv = trimmed.match(/^([A-Za-z ]+):\s+(.+)$/);
    if (kv) {
      const key = kv[1].trim().toLowerCase();
      const value = kv[2].trim();

      if (key === 'device model' || key === 'model number') {
        info.model = info.model || value;
      } else if (key === 'model family' && !info.model) {
        info.model = value;
      } else if (key === 'serial number') {
        info.serial = info.serial || value;
      } else if (key === 'user capacity') {
        const bytes = value.match(/([\d,]+)\s*bytes/);
        if (bytes) info.capacity_bytes = parseInt(bytes[1].replace(/,/g, ''), 10);
      } else if (key === 'temperature' && /celsius|°C/i.test(value)) {
        const temp = value.match(/(-?\d+(?:\.\d+)?)/);
        if (temp) info.temperature_c = parseFloat(temp[1]);
      } else if (key === 'percentage used') {
        const wear = value.match(/(\d+)\s*%/);
        if (wear) info.wear_percent_used = parseInt(wear[1], 10);
      }
      continue;
    }

    // -A attribute table row: id name flag value worst thresh type updated when_failed raw
    const attr = trimmed.match(/^(?:0x[0-9a-f]+|\d+)\s+([A-Za-z0-9_]+)\s+(?:\S+\s+){7}(.+)$/i);
    if (attr) {
      const raw = attr[2].match(/-?\d+(?:\.\d+)?/);
      if (raw) attrRaw[attr[1]] = parseFloat(raw[0]);
    }
  }

  if (info.temperature_c === undefined) {
    const temp = attrRaw['Temperature_Celsius'] ?? attrRaw['Composite'] ?? attrRaw['Temperature'];
    if (temp !== undefined) info.temperature_c = temp;
  }
  if (info.wear_percent_used === undefined && attrRaw['Percentage_Used'] !== undefined) {
    info.wear_percent_used = attrRaw['Percentage_Used'];
  }

  const counters = attrRaw['Current_Pending_Sector'];
  const realloc = attrRaw['Reallocated_Sector_Ct'];
  const reallocEvent = attrRaw['Reallocated_Event_Count'];
  const offline = attrRaw['Offline_Uncorrectable'];
  const crc = attrRaw['UDMA_CRC_Error_Count'];
  if (counters !== undefined || realloc !== undefined || reallocEvent !== undefined || offline !== undefined || crc !== undefined) {
    info.error_counters = {
      current_pending_sector: counters ?? 0,
      reallocated_sector_ct: realloc ?? 0,
      reallocated_event_count: reallocEvent ?? 0,
      offline_uncorrectable: offline ?? 0,
      udma_crc_error_count: crc ?? 0,
    };
  }

  return info;
}

export async function getTemperatures(): Promise<TemperaturesReport> {
  let stdout: string;
  try {
    const result = await execFile('sensors', { timeout: 10000 });
    stdout = result.stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string };
    if (err.code === 'ENOENT') {
      return { chips: [], error: 'lm-sensors not installed' };
    }
    throw error;
  }

  return { chips: parseSensorsOutput(stdout) };
}

function parseSensorsOutput(output: string): ChipTemperatures[] {
  // Join continuation lines like "                       (crit = +84.8°C)" onto their reading line
  const logicalLines: string[] = [];
  for (const line of output.split('\n')) {
    if (/^\s+\(/.test(line) && logicalLines.length > 0) {
      logicalLines[logicalLines.length - 1] += ' ' + line.trim();
      continue;
    }
    logicalLines.push(line);
  }

  const chips: ChipTemperatures[] = [];
  let current: ChipTemperatures | null = null;

  for (const line of logicalLines) {
    // Chip section header: single token, no colon (e.g. "coretemp-isa-0000")
    if (/^[A-Za-z0-9_-]+$/.test(line.trim())) {
      current = { name: line.trim(), adapter: 'unknown', readings: [] };
      chips.push(current);
      continue;
    }

    if (!current) continue;

    const adapter = line.match(/^Adapter:\s*(.+)$/);
    if (adapter) {
      current.adapter = adapter[1].trim();
      continue;
    }

    // Reading: "Core 0:  +57.0°C  (high = +94.0°C, crit = +100.0°C)"
    const reading = line.match(/^([^:]+):\s*\+?(-?\d+(?:\.\d+)?)\s*°C/);
    if (reading) {
      const rest = line.slice(reading[0].length);
      const high = rest.match(/high\s*=\s*\+?(\d+(?:\.\d+)?)°C/);
      const crit = rest.match(/crit(?:ical)?\s*=\s*\+?(\d+(?:\.\d+)?)°C/);
      current.readings.push({
        label: reading[1].trim(),
        current_c: parseFloat(reading[2]),
        high_c: high ? parseFloat(high[1]) : undefined,
        crit_c: crit ? parseFloat(crit[1]) : undefined,
      });
    }
  }

  // Drop chips that expose no temperature readings (e.g. fan-only chips)
  return chips.filter((chip) => chip.readings.length > 0);
}

async function getCPUUsage(): Promise<number> {
  const startUsage = getCPUInfo();

  await new Promise(resolve => setTimeout(resolve, 1000));

  const endUsage = getCPUInfo();

  const idleDiff = endUsage.idle - startUsage.idle;
  const totalDiff = endUsage.total - startUsage.total;

  const cpuPercent = 100 - (100 * idleDiff / totalDiff);

  return parseFloat(cpuPercent.toFixed(2));
}

function getCPUInfo() {
  const cpus = os.cpus();

  let idle = 0;
  let total = 0;

  cpus.forEach(cpu => {
    for (const type in cpu.times) {
      total += cpu.times[type as keyof typeof cpu.times];
    }
    idle += cpu.times.idle;
  });

  return { idle, total };
}

async function getDiskUsage(path: string): Promise<{ usedGB: number; totalGB: number; percent: number }> {
  try {
    // Read /proc/mounts to find the device for the path
    const mounts = await fs.readFile('/proc/mounts', 'utf-8');
    const lines = mounts.split('\n');

    // Find the mount point for the path
    let device = '';
    let mountPoint = '';
    let longestMatch = 0;

    for (const line of lines) {
      const parts = line.split(' ');
      if (parts.length < 2) continue;

      const mount = parts[1];
      if (path.startsWith(mount) && mount.length > longestMatch) {
        device = parts[0];
        mountPoint = mount;
        longestMatch = mount.length;
      }
    }

    if (!device) {
      throw new Error('Could not find device for path');
    }

    // Use statvfs-like approach via /proc/self/mountinfo
    const { execSync } = await import('child_process');
    const dfOutput = execSync(`df -B1 ${mountPoint}`).toString();
    const dfLines = dfOutput.split('\n');

    if (dfLines.length < 2) {
      throw new Error('Unexpected df output');
    }

    const stats = dfLines[1].split(/\s+/);
    const totalBytes = parseInt(stats[1], 10);
    const usedBytes = parseInt(stats[2], 10);

    const totalGB = parseFloat((totalBytes / (1024 ** 3)).toFixed(2));
    const usedGB = parseFloat((usedBytes / (1024 ** 3)).toFixed(2));
    const percent = parseFloat(((usedBytes / totalBytes) * 100).toFixed(2));

    return { usedGB, totalGB, percent };
  } catch (error) {
    // Fallback: return dummy data
    console.warn('[System] Could not get disk usage:', (error as Error).message);
    return { usedGB: 0, totalGB: 0, percent: 0 };
  }
}
