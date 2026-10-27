import https from 'https';
import {
  Config,
  ProxmoxStatus,
  ProxmoxVM,
  ProxmoxVMConfig,
  ProxmoxStorage,
  ProxmoxHostSummary,
  ProxmoxBackupReport,
  OperationResult,
} from '../types.js';

let config: Config;

export function initProxmox(cfg: Config): void {
  config = cfg;
}

async function proxmoxRequest(endpoint: string, method: string = 'GET', body?: any): Promise<any> {
  if (!config.proxmoxHost || !config.proxmoxTokenId || !config.proxmoxTokenSecret) {
    throw new Error('Proxmox is not configured');
  }

  const url = `https://${config.proxmoxHost}:8006/api2/json${endpoint}`;

  const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;

  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'Authorization': `PVEAPIToken=${config.proxmoxTokenId}=${config.proxmoxTokenSecret}`,
      'Content-Type': 'application/json',
    };

    // Proxmox's API rejects chunked transfer encoding (HTTP 501).
    // Set Content-Length so Node.js sends a fixed-length body instead.
    if (bodyStr !== undefined) {
      headers['Content-Length'] = Buffer.byteLength(bodyStr).toString();
    }

    const options: https.RequestOptions = {
      method,
      headers,
      // Allow self-signed certificates
      rejectUnauthorized: false,
    };

    const req = https.request(url, options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsed = JSON.parse(data);
            // Proxmox API wraps responses in { data: ... }
            resolve(parsed.data !== undefined ? parsed.data : parsed);
          } catch {
            resolve(data);
          }
        } else {
          reject(new Error(`Proxmox API error: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    if (bodyStr !== undefined) {
      req.write(bodyStr);
    }

    req.end();
  });
}

// Level 1 - Monitor

export async function getProxmoxStatus(): Promise<ProxmoxStatus> {
  try {
    // Get version
    const version = await proxmoxRequest('/version');

    // Get nodes
    const nodes = await proxmoxRequest('/nodes');

    const nodesFormatted = nodes.map((node: any) => ({
      node: node.node,
      status: node.status === 'online' ? 'online' as const : 'offline' as const,
      cpu_percent: parseFloat(((node.cpu || 0) * 100).toFixed(2)),
      memory_percent: parseFloat(((node.mem || 0) / (node.maxmem || 1) * 100).toFixed(2)),
      uptime: formatUptime(node.uptime || 0),
    }));

    return {
      version: version.version || 'unknown',
      nodes: nodesFormatted,
    };
  } catch (error) {
    throw new Error(`Failed to get Proxmox status: ${(error as Error).message}`);
  }
}

export async function listProxmoxVMs(includeIps: boolean = false): Promise<{ vms: ProxmoxVM[] }> {
  try {
    // Get all nodes first
    const nodes = await proxmoxRequest('/nodes');

    const allVMs: ProxmoxVM[] = [];

    // For each node, get both QEMU VMs and LXC containers
    for (const node of nodes) {
      const nodeName = node.node;
      const nodeVMs: ProxmoxVM[] = [];

      // Get QEMU VMs
      try {
        const qemuVMs = await proxmoxRequest(`/nodes/${nodeName}/qemu`);
        for (const vm of qemuVMs) {
          nodeVMs.push({
            vmid: vm.vmid,
            name: vm.name || `VM ${vm.vmid}`,
            node: nodeName,
            type: 'qemu',
            status: vm.status === 'running' ? 'running' : vm.status === 'paused' ? 'paused' : 'stopped',
            cpu_percent: vm.cpu ? parseFloat((vm.cpu * 100).toFixed(2)) : undefined,
            memory_percent: vm.maxmem ? parseFloat(((vm.mem || 0) / vm.maxmem * 100).toFixed(2)) : undefined,
            uptime: vm.uptime ? formatUptime(vm.uptime) : undefined,
          });
        }
      } catch (e) {
        console.error(`[Proxmox] Could not fetch QEMU VMs for node ${nodeName}:`, (e as Error).message);
      }

      // Get LXC containers
      try {
        const lxcContainers = await proxmoxRequest(`/nodes/${nodeName}/lxc`);
        for (const ct of lxcContainers) {
          nodeVMs.push({
            vmid: ct.vmid,
            name: ct.name || `CT ${ct.vmid}`,
            node: nodeName,
            type: 'lxc',
            status: ct.status === 'running' ? 'running' : ct.status === 'paused' ? 'paused' : 'stopped',
            cpu_percent: ct.cpu ? parseFloat((ct.cpu * 100).toFixed(2)) : undefined,
            memory_percent: ct.maxmem ? parseFloat(((ct.mem || 0) / ct.maxmem * 100).toFixed(2)) : undefined,
            uptime: ct.uptime ? formatUptime(ct.uptime) : undefined,
          });
        }
      } catch (e) {
        console.error(`[Proxmox] Could not fetch LXC containers for node ${nodeName}:`, (e as Error).message);
      }

      // Optionally enrich running guests with their IP addresses.
      // Fire all per-VM requests for this node in parallel instead of sequentially.
      if (includeIps) {
        await Promise.all(nodeVMs.map(async (vm) => {
          if (vm.status !== 'running') return;
          try {
            vm.ips = vm.type === 'qemu'
              ? await getQemuGuestIPs(nodeName, vm.vmid)
              : await getLxcGuestIPs(nodeName, vm.vmid);
          } catch {
            // Guest agent not installed / not responding (e.g. 501) - silently report none
            vm.ips = [];
          }
        }));
      }

      allVMs.push(...nodeVMs);
    }

    return { vms: allVMs };
  } catch (error) {
    throw new Error(`Failed to list Proxmox VMs: ${(error as Error).message}`);
  }
}

export async function getProxmoxHostStatus(): Promise<ProxmoxHostSummary | null> {
  if (!config.proxmoxHost || !config.proxmoxTokenId || !config.proxmoxTokenSecret) {
    return null;
  }

  const nodes = await proxmoxRequest('/nodes');
  const online = (nodes as any[]).find((n) => n.status === 'online');
  if (!online) {
    throw new Error('No online Proxmox nodes found');
  }

  const status = await proxmoxRequest(`/nodes/${online.node}/status`);

  // PVE <=8 uses flat fields (mem/maxmem/ksm/swapused, loadavg string);
  // PVE 9 returns structured objects (memory/swap/ksm, loadavg array).
  const memUsed = status.mem ?? status.memory?.used ?? 0;
  const memTotal = status.maxmem ?? status.memory?.total ?? 0;
  // A real node always reports memory; 0 total means the API format changed
  // again. Fail loudly so the caller reports proxmox_host: null instead of
  // silently looking like "0 GB used / 0%".
  if (memTotal <= 0) {
    throw new Error('Node status returned no memory fields (unexpected Proxmox API format)');
  }
  const loadavg = Array.isArray(status.loadavg)
    ? status.loadavg.join(' ')
    : status.loadavg !== undefined
      ? String(status.loadavg).trim()
      : undefined;

  const summary: ProxmoxHostSummary = {
    node: status.node || online.node,
    cpu_percent: parseFloat(((status.cpu || 0) * 100).toFixed(2)),
    memory_used_gb: parseFloat((memUsed / (1024 ** 3)).toFixed(2)),
    memory_total_gb: parseFloat((memTotal / (1024 ** 3)).toFixed(2)),
    memory_percent: parseFloat((memTotal > 0 ? (memUsed / memTotal) * 100 : 0).toFixed(2)),
    uptime: formatUptime(status.uptime || 0),
    loadavg,
  };

  const ksm = status.ksm && typeof status.ksm === 'object' ? status.ksm.shared : status.ksm;
  if (ksm !== undefined && ksm !== null) {
    summary.ksm_shared_gb = parseFloat((ksm / (1024 ** 3)).toFixed(2));
  }
  const swapUsed = status.swapused ?? (status.swap && typeof status.swap === 'object' ? status.swap.used : undefined);
  if (swapUsed !== undefined && swapUsed !== null) {
    summary.swap_used_gb = parseFloat((swapUsed / (1024 ** 3)).toFixed(2));
  }

  return summary;
}

export async function getProxmoxBackupStatus(): Promise<ProxmoxBackupReport> {
  const nodes = await proxmoxRequest('/nodes');

  // Collect backup entries from all active backup-capable storages (incl. PBS), grouped by vmid
  const backupsByVmid = new Map<number, any[]>();

  for (const node of nodes) {
    const nodeName = node.node;
    let storages: any[] = [];
    try {
      storages = await proxmoxRequest(`/nodes/${nodeName}/storage`);
    } catch (e) {
      console.error(`[Proxmox] Could not fetch storage for node ${nodeName}:`, (e as Error).message);
      continue;
    }

    const backupStores = storages.filter(
      (s) => (s.content || '').includes('backup') && s.active === 1
    );

    for (const store of backupStores) {
      try {
        const entries = await proxmoxRequest(
          `/nodes/${nodeName}/storage/${store.storage}/content?content=backup`
        );
        for (const entry of entries) {
          const vmid = typeof entry.vmid === 'number' ? entry.vmid : vmidFromVolid(entry.volid);
          if (vmid === null) continue;
          if (!backupsByVmid.has(vmid)) backupsByVmid.set(vmid, []);
          backupsByVmid.get(vmid)!.push(entry);
        }
      } catch (e) {
        console.error(`[Proxmox] Could not list backup content of ${store.storage}:`, (e as Error).message);
      }
    }
  }

  // Cross-reference the full guest list so unbacked guests show up too
  const { vms } = await listProxmoxVMs();
  const now = Date.now();

  const guests: ProxmoxBackupReport['guests'] = vms.map((vm) => {
    const entries = (backupsByVmid.get(vm.vmid) || [])
      .slice()
      .sort((a, b) => backupTime(b) - backupTime(a));
    const latest = entries[0];

    return {
      vmid: vm.vmid,
      name: vm.name,
      node: vm.node,
      type: vm.type,
      backups_kept: entries.length,
      last_backup: latest
        ? {
            volid: latest.volid,
            size_gb: parseFloat(((latest.size || 0) / (1024 ** 3)).toFixed(2)),
            backup_time: new Date(backupTime(latest) * 1000).toISOString(),
            age: formatAge(now - backupTime(latest) * 1000),
          }
        : null,
    };
  });

  const backedUp24h = guests.filter(
    (g) => g.last_backup && now - Date.parse(g.last_backup.backup_time) < 24 * 3600 * 1000
  ).length;

  return {
    guests,
    summary: {
      backed_up_24h: backedUp24h,
      backed_up_older: guests.filter((g) => g.last_backup).length - backedUp24h,
      never_backed_up: guests.filter((g) => !g.last_backup).length,
    },
  };
}

export async function getProxmoxVMStatus(node: string, vmid: number, type: 'qemu' | 'lxc'): Promise<ProxmoxVM> {
  try {
    const vmType = type === 'lxc' ? 'lxc' : 'qemu';
    const status = await proxmoxRequest(`/nodes/${node}/${vmType}/${vmid}/status/current`);

    return {
      vmid,
      name: status.name || `${type.toUpperCase()} ${vmid}`,
      node,
      type,
      status: status.status === 'running' ? 'running' : status.status === 'paused' ? 'paused' : 'stopped',
      cpu_percent: status.cpu ? parseFloat((status.cpu * 100).toFixed(2)) : undefined,
      memory_percent: status.maxmem ? parseFloat(((status.mem || 0) / status.maxmem * 100).toFixed(2)) : undefined,
      uptime: status.uptime ? formatUptime(status.uptime) : undefined,
    };
  } catch (error) {
    throw new Error(`Failed to get VM status: ${(error as Error).message}`);
  }
}

// Level 2 - Operate

export async function startProxmoxVM(
  node: string,
  vmid: number,
  type: 'qemu' | 'lxc'
): Promise<OperationResult & { vmid: number }> {
  try {
    const vmType = type === 'lxc' ? 'lxc' : 'qemu';
    await proxmoxRequest(`/nodes/${node}/${vmType}/${vmid}/status/start`, 'POST', {});

    return {
      success: true,
      vmid,
      message: `${type.toUpperCase()} ${vmid} started successfully`,
    };
  } catch (error) {
    return {
      success: false,
      vmid,
      message: `Failed to start VM: ${(error as Error).message}`,
    };
  }
}

export async function stopProxmoxVM(
  node: string,
  vmid: number,
  type: 'qemu' | 'lxc'
): Promise<OperationResult & { vmid: number }> {
  try {
    const vmType = type === 'lxc' ? 'lxc' : 'qemu';
    await proxmoxRequest(`/nodes/${node}/${vmType}/${vmid}/status/stop`, 'POST', {});

    return {
      success: true,
      vmid,
      message: `${type.toUpperCase()} ${vmid} stopped successfully`,
    };
  } catch (error) {
    return {
      success: false,
      vmid,
      message: `Failed to stop VM: ${(error as Error).message}`,
    };
  }
}

export async function shutdownProxmoxVM(
  node: string,
  vmid: number,
  type: 'qemu' | 'lxc'
): Promise<OperationResult & { vmid: number }> {
  try {
    const vmType = type === 'lxc' ? 'lxc' : 'qemu';
    await proxmoxRequest(`/nodes/${node}/${vmType}/${vmid}/status/shutdown`, 'POST', {});

    return {
      success: true,
      vmid,
      message: `${type.toUpperCase()} ${vmid} shutdown initiated`,
    };
  } catch (error) {
    return {
      success: false,
      vmid,
      message: `Failed to shutdown VM: ${(error as Error).message}`,
    };
  }
}

export async function rebootProxmoxVM(
  node: string,
  vmid: number,
  type: 'qemu' | 'lxc'
): Promise<OperationResult & { vmid: number }> {
  try {
    const vmType = type === 'lxc' ? 'lxc' : 'qemu';
    await proxmoxRequest(`/nodes/${node}/${vmType}/${vmid}/status/reboot`, 'POST', {});

    return {
      success: true,
      vmid,
      message: `${type.toUpperCase()} ${vmid} rebooted successfully`,
    };
  } catch (error) {
    return {
      success: false,
      vmid,
      message: `Failed to reboot VM: ${(error as Error).message}`,
    };
  }
}

// Level 3 - Configure

export async function getProxmoxVMConfig(
  node: string,
  vmid: number,
  type: 'qemu' | 'lxc'
): Promise<ProxmoxVMConfig> {
  try {
    const vmType = type === 'lxc' ? 'lxc' : 'qemu';
    const config = await proxmoxRequest(`/nodes/${node}/${vmType}/${vmid}/config`);

    return {
      vmid,
      name: config.name || config.hostname || `${type.toUpperCase()} ${vmid}`,
      node,
      type,
      cores: config.cores || config.cpus,
      memory: config.memory,
      disk: config.bootdisk || config.rootfs,
      config,
    };
  } catch (error) {
    throw new Error(`Failed to get VM config: ${(error as Error).message}`);
  }
}

export async function listProxmoxStorage(node?: string): Promise<{ storage: ProxmoxStorage[] }> {
  try {
    let storageList: any[] = [];

    if (node) {
      // Get storage for specific node
      storageList = await proxmoxRequest(`/nodes/${node}/storage`);
      storageList = storageList.map((s: any) => ({ ...s, node }));
    } else {
      // Get all nodes and their storage
      const nodes = await proxmoxRequest('/nodes');
      for (const n of nodes) {
        const nodeStorage = await proxmoxRequest(`/nodes/${n.node}/storage`);
        storageList.push(...nodeStorage.map((s: any) => ({ ...s, node: n.node })));
      }
    }

    const storageFormatted = storageList.map((storage: any) => {
      const totalBytes = storage.total || 0;
      const usedBytes = storage.used || 0;
      const usedPercent = totalBytes > 0 ? parseFloat((usedBytes / totalBytes * 100).toFixed(2)) : 0;

      return {
        storage: storage.storage,
        type: storage.type || 'unknown',
        content: storage.content || 'unknown',
        active: storage.active === 1,
        used_gb: parseFloat((usedBytes / (1024 ** 3)).toFixed(2)),
        total_gb: parseFloat((totalBytes / (1024 ** 3)).toFixed(2)),
        used_percent: usedPercent,
      };
    });

    return { storage: storageFormatted };
  } catch (error) {
    throw new Error(`Failed to list Proxmox storage: ${(error as Error).message}`);
  }
}

export async function listProxmoxNodes(): Promise<{ nodes: Array<{ node: string; status: string; uptime: string }> }> {
  try {
    const nodes = await proxmoxRequest('/nodes');

    const nodesFormatted = nodes.map((node: any) => ({
      node: node.node,
      status: node.status || 'unknown',
      uptime: formatUptime(node.uptime || 0),
    }));

    return { nodes: nodesFormatted };
  } catch (error) {
    throw new Error(`Failed to list Proxmox nodes: ${(error as Error).message}`);
  }
}

// Level 4 - Manage

export async function createProxmoxVMSnapshot(
  node: string,
  vmid: number,
  type: 'qemu' | 'lxc',
  snapname?: string
): Promise<OperationResult & { snapshot: string }> {
  try {
    const vmType = type === 'lxc' ? 'lxc' : 'qemu';
    const snapshotName = snapname || `snapshot-${Date.now()}`;

    await proxmoxRequest(`/nodes/${node}/${vmType}/${vmid}/snapshot`, 'POST', {
      snapname: snapshotName,
    });

    return {
      success: true,
      snapshot: snapshotName,
      message: `Snapshot ${snapshotName} created successfully for ${type.toUpperCase()} ${vmid}`,
    };
  } catch (error) {
    return {
      success: false,
      snapshot: snapname || 'unknown',
      message: `Failed to create snapshot: ${(error as Error).message}`,
    };
  }
}

export async function deleteProxmoxVM(
  node: string,
  vmid: number,
  type: 'qemu' | 'lxc'
): Promise<OperationResult & { vmid: number }> {
  try {
    const vmType = type === 'lxc' ? 'lxc' : 'qemu';
    await proxmoxRequest(`/nodes/${node}/${vmType}/${vmid}`, 'DELETE');

    return {
      success: true,
      vmid,
      message: `${type.toUpperCase()} ${vmid} deleted successfully`,
    };
  } catch (error) {
    return {
      success: false,
      vmid,
      message: `Failed to delete VM: ${(error as Error).message}`,
    };
  }
}

// Helper functions

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else {
    return `${minutes}m`;
  }
}

function formatAge(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function vmidFromVolid(volid: string): number | null {
  if (!volid) return null;
  // e.g. "pbs:backup/vm/101/2026-10-26T02:00:00Z", "pbs:backup/ct/101/..." or "local:backup/vm/dump/vzdump-lxc-101-..."
  const match = volid.match(/\/(?:vm|ct)\/(\d+)\//) || volid.match(/vzdump-(?:qemu|lxc)-(\d+)-/);
  return match ? parseInt(match[1], 10) : null;
}

function backupTime(entry: any): number {
  // PVE storage content entries expose `ctime`; older builds use `backup-time`
  return entry['backup-time'] ?? entry.ctime ?? 0;
}

async function getQemuGuestIPs(node: string, vmid: number): Promise<string[]> {
  const res = await proxmoxRequest(`/nodes/${node}/qemu/${vmid}/agent/interfaces`);
  const interfaces = Array.isArray(res) ? res : res?.result ?? [];

  const ips: string[] = [];
  for (const iface of interfaces) {
    for (const addr of iface['ip-addresses'] || []) {
      const ip = addr['ip-address'];
      if (ip && ip !== '127.0.0.1' && ip !== '::1' && !ip.startsWith('fe80::')) {
        ips.push(ip);
      }
    }
  }
  return [...new Set(ips)];
}

async function getLxcGuestIPs(node: string, vmid: number): Promise<string[]> {
  const interfaces = await proxmoxRequest(`/nodes/${node}/lxc/${vmid}/interfaces`);

  const ips: string[] = [];
  for (const iface of Array.isArray(interfaces) ? interfaces : []) {
    for (const key of ['inet', 'inet6']) {
      const raw = iface[key];
      const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
      for (const value of list) {
        if (typeof value !== 'string') continue;
        const ip = value.split('/')[0].trim();
        if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('fe80::')) continue;
        ips.push(ip);
      }
    }
  }
  return [...new Set(ips)];
}
