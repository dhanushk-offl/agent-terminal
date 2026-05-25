use std::collections::{HashMap, HashSet};

pub async fn listening_ports_per_pid(
    direct_pids: &[u32],
    attribution: &HashMap<u32, u32>,
) -> HashMap<u32, Vec<u16>> {
    if direct_pids.is_empty() {
        return HashMap::new();
    }

    let direct_pids = direct_pids.to_vec();
    let attribution = attribution.clone();

    tokio::task::spawn_blocking(move || scan_listening_ports(&direct_pids, &attribution))
        .await
        .unwrap_or_default()
}

fn scan_listening_ports(
    direct_pids: &[u32],
    attribution: &HashMap<u32, u32>,
) -> HashMap<u32, Vec<u16>> {
    #[cfg(target_os = "linux")]
    {
        linux::scan_listening_ports(direct_pids, attribution)
    }

    #[cfg(target_os = "macos")]
    {
        macos::scan_listening_ports(direct_pids, attribution)
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (direct_pids, attribution);
        HashMap::new()
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::fs;
    use std::path::Path;

    pub fn scan_listening_ports(
        direct_pids: &[u32],
        attribution: &HashMap<u32, u32>,
    ) -> HashMap<u32, Vec<u16>> {
        let _ = direct_pids;

        let inode_ports = collect_listening_inode_ports();
        if inode_ports.is_empty() {
            return HashMap::new();
        }

        let mut result: HashMap<u32, HashSet<u16>> = HashMap::new();

        for (&raw_pid, &root_pid) in attribution {
            let fd_dir = format!("/proc/{raw_pid}/fd");
            let Ok(entries) = fs::read_dir(&fd_dir) else {
                continue;
            };

            for entry in entries.flatten() {
                let Ok(target) = fs::read_link(entry.path()) else {
                    continue;
                };

                let Some(inode) = parse_socket_inode(&target) else {
                    continue;
                };

                let Some(&port) = inode_ports.get(&inode) else {
                    continue;
                };

                result.entry(root_pid).or_default().insert(port);
            }
        }

        finalize(result)
    }

    fn collect_listening_inode_ports() -> HashMap<u64, u16> {
        let mut ports = HashMap::new();
        collect_from_proc_net("/proc/net/tcp", &mut ports);
        collect_from_proc_net("/proc/net/tcp6", &mut ports);
        ports
    }

    fn collect_from_proc_net(path: &str, ports: &mut HashMap<u64, u16>) {
        let Ok(contents) = fs::read_to_string(path) else {
            return;
        };

        for line in contents.lines().skip(1) {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 10 || fields[3] != "0A" {
                continue;
            }

            let Some(port_hex) = fields[1].rsplit(':').next() else {
                continue;
            };
            let Ok(port) = u16::from_str_radix(port_hex, 16) else {
                continue;
            };
            let Ok(inode) = fields[9].parse::<u64>() else {
                continue;
            };

            ports.entry(inode).or_insert(port);
        }
    }

    fn parse_socket_inode(path: &Path) -> Option<u64> {
        let text = path.to_string_lossy();
        text.strip_prefix("socket:[")
            .and_then(|rest| rest.strip_suffix(']'))
            .and_then(|inode| inode.parse::<u64>().ok())
    }

    fn finalize(result: HashMap<u32, HashSet<u16>>) -> HashMap<u32, Vec<u16>> {
        let mut output = HashMap::new();
        for (pid, ports) in result {
            let mut ports: Vec<u16> = ports.into_iter().collect();
            ports.sort_unstable();
            output.insert(pid, ports);
        }
        output
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use libc::{c_int, c_void};
    use std::mem::{size_of, MaybeUninit};

    const PROC_PIDLISTFDS: c_int = 1;
    const PROC_PIDFDSOCKETINFO: c_int = 3;
    const PROX_FDTYPE_SOCKET: u32 = 2;
    const SOCKINFO_TCP: i32 = 2;
    const TSI_S_LISTEN: i32 = 1;

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct ProcFdInfo {
        proc_fd: i32,
        proc_fdtype: u32,
    }

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct VinfoStat {
        vst_dev: u32,
        vst_mode: u16,
        vst_nlink: u16,
        vst_ino: u64,
        vst_uid: libc::uid_t,
        vst_gid: libc::gid_t,
        vst_atime: i64,
        vst_atimensec: i64,
        vst_mtime: i64,
        vst_mtimensec: i64,
        vst_ctime: i64,
        vst_ctimensec: i64,
        vst_birthtime: i64,
        vst_birthtimensec: i64,
        vst_size: libc::off_t,
        vst_blocks: i64,
        vst_blksize: i32,
        vst_flags: u32,
        vst_gen: u32,
        vst_rdev: u32,
        vst_qspare: [i64; 2],
    }

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct SockbufInfo {
        sbi_cc: u32,
        sbi_hiwat: u32,
        sbi_mbcnt: u32,
        sbi_mbmax: u32,
        sbi_lowat: u32,
        sbi_flags: i16,
        sbi_timeo: i16,
    }

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct InsiV4 {
        in4_tos: u8,
    }

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct InsiV6 {
        in6_hlim: u8,
        in6_cksum: i32,
        in6_ifindex: u16,
        in6_hops: i16,
    }

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct InSockInfo {
        insi_fport: i32,
        insi_lport: i32,
        insi_gencnt: u64,
        insi_flags: u32,
        insi_flow: u32,
        insi_vflag: u8,
        insi_ip_ttl: u8,
        rfu_1: u32,
        insi_faddr: [u8; 16],
        insi_laddr: [u8; 16],
        insi_v4: InsiV4,
        insi_v6: InsiV6,
    }

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct TcpSockInfo {
        tcpsi_ini: InSockInfo,
        tcpsi_state: i32,
        tcpsi_timer: [i32; 4],
        tcpsi_mss: i32,
        tcpsi_flags: u32,
        rfu_1: u32,
        tcpsi_tp: u64,
    }

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct UnSockInfo {
        unsi_conn_so: u64,
        unsi_conn_pcb: u64,
        unsi_addr: [u8; 256],
        unsi_caddr: [u8; 256],
    }

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct NdrvInfo {
        ndrvsi_if_family: u32,
        ndrvsi_if_unit: u32,
        ndrvsi_if_name: [u8; 16],
    }

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct KernEventInfo {
        kesi_vendor_code_filter: u32,
        kesi_class_filter: u32,
        kesi_subclass_filter: u32,
    }

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct KernCtlInfo {
        kcsi_id: u32,
        kcsi_reg_unit: u32,
        kcsi_flags: u32,
        kcsi_recvbufsize: u32,
        kcsi_sendbufsize: u32,
        kcsi_unit: u32,
        kcsi_name: [u8; 96],
    }

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct VsockSockInfo {
        local_cid: u32,
        local_port: u32,
        remote_cid: u32,
        remote_port: u32,
    }

    #[repr(C)]
    #[derive(Copy, Clone)]
    union SocketProto {
        pri_in: InSockInfo,
        pri_tcp: TcpSockInfo,
        pri_un: UnSockInfo,
        pri_ndrv: NdrvInfo,
        pri_kern_event: KernEventInfo,
        pri_kern_ctl: KernCtlInfo,
        pri_vsock: VsockSockInfo,
    }

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct SocketInfo {
        soi_stat: VinfoStat,
        soi_so: u64,
        soi_pcb: u64,
        soi_type: i32,
        soi_protocol: i32,
        soi_family: i32,
        soi_options: i16,
        soi_linger: i16,
        soi_state: i16,
        soi_qlen: i16,
        soi_incqlen: i16,
        soi_qlimit: i16,
        soi_timeo: i16,
        soi_error: u16,
        soi_oobmark: u32,
        soi_rcv: SockbufInfo,
        soi_snd: SockbufInfo,
        soi_kind: i32,
        rfu_1: u32,
        soi_proto: SocketProto,
    }

    #[repr(C)]
    #[derive(Copy, Clone)]
    struct SocketFdInfo {
        pfi: ProcFdInfo,
        psi: SocketInfo,
    }

    #[link(name = "proc")]
    extern "C" {
        fn proc_pidinfo(
            pid: c_int,
            flavor: c_int,
            arg: u64,
            buffer: *mut c_void,
            buffersize: c_int,
        ) -> c_int;

        fn proc_pidfdinfo(
            pid: c_int,
            fd: c_int,
            flavor: c_int,
            buffer: *mut c_void,
            buffersize: c_int,
        ) -> c_int;
    }

    pub fn scan_listening_ports(
        direct_pids: &[u32],
        attribution: &HashMap<u32, u32>,
    ) -> HashMap<u32, Vec<u16>> {
        let _ = direct_pids;

        let mut result: HashMap<u32, HashSet<u16>> = HashMap::new();

        for (&raw_pid, &root_pid) in attribution {
            let fd_bytes = unsafe {
                proc_pidinfo(
                    raw_pid as c_int,
                    PROC_PIDLISTFDS,
                    0,
                    std::ptr::null_mut(),
                    0,
                )
            };
            if fd_bytes <= 0 {
                continue;
            }

            let mut buffer = vec![0u8; fd_bytes as usize];
            let actual = unsafe {
                proc_pidinfo(
                    raw_pid as c_int,
                    PROC_PIDLISTFDS,
                    0,
                    buffer.as_mut_ptr() as *mut c_void,
                    buffer.len() as c_int,
                )
            };
            if actual <= 0 {
                continue;
            }

            let entry_size = size_of::<ProcFdInfo>();
            let entry_count = (actual as usize) / entry_size;
            for idx in 0..entry_count {
                let offset = idx * entry_size;
                let fdinfo = unsafe {
                    std::ptr::read_unaligned(buffer.as_ptr().add(offset) as *const ProcFdInfo)
                };

                if fdinfo.proc_fdtype != PROX_FDTYPE_SOCKET {
                    continue;
                }

                let mut socket_info = MaybeUninit::<SocketFdInfo>::zeroed();
                let ret = unsafe {
                    proc_pidfdinfo(
                        raw_pid as c_int,
                        fdinfo.proc_fd,
                        PROC_PIDFDSOCKETINFO,
                        socket_info.as_mut_ptr() as *mut c_void,
                        size_of::<SocketFdInfo>() as c_int,
                    )
                };
                if ret <= 0 {
                    continue;
                }

                let socket_info = unsafe { socket_info.assume_init() };
                let tcp = unsafe { socket_info.psi.soi_proto.pri_tcp };
                if socket_info.psi.soi_kind != SOCKINFO_TCP || tcp.tcpsi_state != TSI_S_LISTEN {
                    continue;
                }

                let port = u16::from_be(tcp.tcpsi_ini.insi_lport as u16);
                result.entry(root_pid).or_default().insert(port);
            }
        }

        finalize(result)
    }

    fn finalize(result: HashMap<u32, HashSet<u16>>) -> HashMap<u32, Vec<u16>> {
        let mut output = HashMap::new();
        for (pid, ports) in result {
            let mut ports: Vec<u16> = ports.into_iter().collect();
            ports.sort_unstable();
            output.insert(pid, ports);
        }
        output
    }
}
