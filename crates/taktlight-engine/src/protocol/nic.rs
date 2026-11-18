use std::net::Ipv4Addr;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetworkInterfaceInfo {
    pub name: String,
    pub ipv4: Ipv4Addr,
    pub netmask: Ipv4Addr,
    pub broadcast: Ipv4Addr,
    pub subnet_cidr: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum AdapterSelection {
    #[default]
    Auto,
    Offline,
    Named {
        name: String,
        subnet_cidr: String,
    },
}

pub fn subnet_directed_broadcast(ip: Ipv4Addr, netmask: Ipv4Addr) -> Ipv4Addr {
    Ipv4Addr::from(u32::from(ip) | !u32::from(netmask))
}

pub fn prefix_len_from_netmask(netmask: Ipv4Addr) -> u8 {
    u32::from(netmask).count_ones() as u8
}

pub fn format_subnet_cidr(ip: Ipv4Addr, netmask: Ipv4Addr) -> String {
    let network = Ipv4Addr::from(u32::from(ip) & u32::from(netmask));
    let prefix = prefix_len_from_netmask(netmask);
    format!("{}/{}", network, prefix)
}

pub fn enumerate_ipv4_interfaces() -> Vec<NetworkInterfaceInfo> {
    let Ok(addrs) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };

    let mut result = Vec::new();
    for iface in addrs {
        if iface.is_loopback() {
            continue;
        }
        if let if_addrs::IfAddr::V4(v4) = iface.addr {
            if v4.ip.is_loopback() || v4.ip.is_link_local() || v4.ip.is_unspecified() {
                continue;
            }
            let broadcast = v4
                .broadcast
                .unwrap_or_else(|| subnet_directed_broadcast(v4.ip, v4.netmask));
            let subnet_cidr = format_subnet_cidr(v4.ip, v4.netmask);
            result.push(NetworkInterfaceInfo {
                name: iface.name,
                ipv4: v4.ip,
                netmask: v4.netmask,
                broadcast,
                subnet_cidr,
            });
        }
    }

    result.sort_by(|a, b| a.name.cmp(&b.name).then(a.ipv4.cmp(&b.ipv4)));
    result
}

pub fn resolve_adapter(
    interfaces: &[NetworkInterfaceInfo],
    selection: &AdapterSelection,
) -> Option<NetworkInterfaceInfo> {
    match selection {
        AdapterSelection::Offline => None,
        AdapterSelection::Auto => interfaces.first().cloned(),
        AdapterSelection::Named { name, subnet_cidr } => interfaces
            .iter()
            .find(|iface| iface.name == *name && iface.subnet_cidr == *subnet_cidr)
            .or_else(|| interfaces.iter().find(|iface| iface.name == *name))
            .cloned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subnet_directed_broadcast_computes_host_ones() {
        assert_eq!(
            subnet_directed_broadcast(
                Ipv4Addr::new(192, 168, 1, 50),
                Ipv4Addr::new(255, 255, 255, 0)
            ),
            Ipv4Addr::new(192, 168, 1, 255)
        );
        assert_eq!(
            subnet_directed_broadcast(Ipv4Addr::new(10, 4, 12, 8), Ipv4Addr::new(255, 0, 0, 0)),
            Ipv4Addr::new(10, 255, 255, 255)
        );
        assert_eq!(
            subnet_directed_broadcast(
                Ipv4Addr::new(172, 16, 42, 9),
                Ipv4Addr::new(255, 255, 240, 0)
            ),
            Ipv4Addr::new(172, 16, 47, 255)
        );
    }

    #[test]
    fn format_subnet_cidr_masks_network_bits() {
        assert_eq!(
            format_subnet_cidr(
                Ipv4Addr::new(192, 168, 1, 50),
                Ipv4Addr::new(255, 255, 255, 0)
            ),
            "192.168.1.0/24"
        );
        assert_eq!(
            format_subnet_cidr(Ipv4Addr::new(2, 10, 20, 30), Ipv4Addr::new(255, 0, 0, 0)),
            "2.0.0.0/8"
        );
    }

    #[test]
    fn resolve_adapter_handles_auto_offline_and_named() {
        let interfaces = vec![
            NetworkInterfaceInfo {
                name: "Ethernet 2".into(),
                ipv4: Ipv4Addr::new(192, 168, 1, 10),
                netmask: Ipv4Addr::new(255, 255, 255, 0),
                broadcast: Ipv4Addr::new(192, 168, 1, 255),
                subnet_cidr: "192.168.1.0/24".into(),
            },
            NetworkInterfaceInfo {
                name: "Wi-Fi".into(),
                ipv4: Ipv4Addr::new(10, 0, 0, 5),
                netmask: Ipv4Addr::new(255, 255, 255, 0),
                broadcast: Ipv4Addr::new(10, 0, 0, 255),
                subnet_cidr: "10.0.0.0/24".into(),
            },
        ];

        assert_eq!(
            resolve_adapter(&interfaces, &AdapterSelection::Offline),
            None
        );
        assert_eq!(
            resolve_adapter(&interfaces, &AdapterSelection::Auto)
                .unwrap()
                .name,
            "Ethernet 2"
        );
        assert_eq!(
            resolve_adapter(
                &interfaces,
                &AdapterSelection::Named {
                    name: "Wi-Fi".into(),
                    subnet_cidr: "10.0.0.0/24".into()
                }
            )
            .unwrap()
            .ipv4,
            Ipv4Addr::new(10, 0, 0, 5)
        );
        assert_eq!(
            resolve_adapter(
                &interfaces,
                &AdapterSelection::Named {
                    name: "Missing".into(),
                    subnet_cidr: "10.0.0.0/24".into()
                }
            ),
            None
        );
    }
}
