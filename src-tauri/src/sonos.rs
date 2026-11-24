//! Sonos speakers over their local UPnP interface (port 1400): SSDP discovery,
//! group topology, and SOAP calls for transport and volume. Unofficial but
//! long-stable; it is what SoCo and Home Assistant use. Spike-level: no event
//! subscriptions yet, callers poll.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

const SSDP_ADDR: &str = "239.255.255.250:1900";
const ZONE_PLAYER: &str = "urn:schemas-upnp-org:device:ZonePlayer:1";

const AV_TRANSPORT: (&str, &str) = ("/MediaRenderer/AVTransport/Control", "urn:schemas-upnp-org:service:AVTransport:1");
const RENDERING: (&str, &str) = ("/MediaRenderer/RenderingControl/Control", "urn:schemas-upnp-org:service:RenderingControl:1");
const TOPOLOGY: (&str, &str) = ("/ZoneGroupTopology/Control", "urn:schemas-upnp-org:service:ZoneGroupTopology:1");

#[derive(Debug, Clone)]
pub struct Speaker {
    pub ip: IpAddr,
    pub room: String,
    pub model: String,
    /// `RINCON_...`, without the `uuid:` prefix.
    pub uuid: String,
}

#[derive(Debug, Clone)]
pub struct Group {
    pub coordinator: String,
    /// (uuid, ip, room). Bonded satellites and subs are left out.
    pub members: Vec<(String, IpAddr, String)>,
}

#[derive(Debug, Clone, Default)]
pub struct Position {
    pub track_s: u32,
    pub rel_s: u32,
    pub uri: String,
}

/// Send SSDP M-SEARCH for Sonos players on every IPv4 interface and collect
/// the answering IPs. Per interface because the default route may be a VPN
/// tunnel, which would carry a single unbound multicast away from the LAN.
pub async fn discover_ips(wait: Duration) -> std::io::Result<Vec<IpAddr>> {
    let msg = format!(
        "M-SEARCH * HTTP/1.1\r\nHOST: {SSDP_ADDR}\r\nMAN: \"ssdp:discover\"\r\nMX: 1\r\nST: {ZONE_PLAYER}\r\n\r\n"
    );
    let mut locals: Vec<IpAddr> = if_addrs::get_if_addrs()?
        .into_iter()
        .map(|i| i.ip())
        .filter(|ip| ip.is_ipv4() && !ip.is_loopback())
        .collect();
    if locals.is_empty() {
        locals.push(IpAddr::from([0, 0, 0, 0]));
    }
    let mut socks = Vec::new();
    for ip in locals {
        let Ok(sock) = tokio::net::UdpSocket::bind((ip, 0)).await else { continue };
        let mut sent = false;
        for _ in 0..2 {
            sent |= sock.send_to(msg.as_bytes(), SSDP_ADDR).await.is_ok();
        }
        if sent {
            socks.push(sock);
        }
    }
    let deadline = tokio::time::Instant::now() + wait;
    let mut ips = Vec::new();
    let listeners = socks.into_iter().map(|sock| async move {
        let mut found = Vec::new();
        let mut buf = [0u8; 2048];
        while let Ok(Ok((n, from))) = tokio::time::timeout_at(deadline, sock.recv_from(&mut buf)).await {
            if is_sonos_reply(&String::from_utf8_lossy(&buf[..n])) {
                found.push(from.ip());
            }
        }
        found
    });
    for ip in futures_join(listeners).await.into_iter().flatten() {
        if !ips.contains(&ip) {
            ips.push(ip);
        }
    }
    Ok(ips)
}

async fn futures_join<F: std::future::Future + Send + 'static>(fs: impl Iterator<Item = F>) -> Vec<F::Output>
where
    F::Output: Send + 'static,
{
    let handles: Vec<_> = fs.map(tokio::spawn).collect();
    let mut out = Vec::new();
    for h in handles {
        if let Ok(v) = h.await {
            out.push(v);
        }
    }
    out
}

fn is_sonos_reply(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    t.contains(&ZONE_PLAYER.to_ascii_lowercase()) || t.contains("sonos")
}

/// Room name, model and uuid from the speaker's device description.
pub async fn describe(client: &reqwest::Client, ip: IpAddr) -> Result<Speaker, String> {
    let url = format!("http://{}/xml/device_description.xml", SocketAddr::new(ip, 1400));
    let xml = client.get(&url).send().await.map_err(|e| e.to_string())?.text().await.map_err(|e| e.to_string())?;
    Ok(Speaker {
        ip,
        room: tag_text(&xml, "roomName").unwrap_or_default(),
        model: tag_text(&xml, "modelName").unwrap_or_default(),
        uuid: tag_text(&xml, "UDN").unwrap_or_default().trim_start_matches("uuid:").to_string(),
    })
}

/// The local address this machine uses to reach `peer` (no packet is sent).
pub fn local_ip_toward(peer: IpAddr) -> std::io::Result<IpAddr> {
    let s = std::net::UdpSocket::bind(if peer.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" })?;
    s.connect(SocketAddr::new(peer, 1400))?;
    Ok(s.local_addr()?.ip())
}

pub struct Sonos {
    client: reqwest::Client,
}

impl Default for Sonos {
    fn default() -> Self {
        Self::new()
    }
}

impl Sonos {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(3))
            .timeout(Duration::from_secs(10))
            .build()
            .expect("reqwest client");
        Self { client }
    }

    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    async fn soap(&self, ip: IpAddr, svc: (&str, &str), action: &str, args: &[(&str, &str)]) -> Result<String, String> {
        let (path, urn) = svc;
        let mut body = String::new();
        for (k, v) in args {
            body.push_str(&format!("<{k}>{}</{k}>", xml_escape(v)));
        }
        let envelope = format!(
            r#"<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:{action} xmlns:u="{urn}">{body}</u:{action}></s:Body></s:Envelope>"#
        );
        let url = format!("http://{}{path}", SocketAddr::new(ip, 1400));
        let r = self
            .client
            .post(&url)
            .header("Content-Type", r#"text/xml; charset="utf-8""#)
            .header("SOAPACTION", format!("\"{urn}#{action}\""))
            .body(envelope)
            .send()
            .await
            .map_err(|e| format!("{action}: {e}"))?;
        let status = r.status();
        let text = r.text().await.map_err(|e| format!("{action}: {e}"))?;
        if !status.is_success() {
            let code = tag_text(&text, "errorCode").unwrap_or_else(|| status.as_u16().to_string());
            return Err(format!("{action}: UPnP error {code}"));
        }
        Ok(text)
    }

    pub async fn groups(&self, ip: IpAddr) -> Result<Vec<Group>, String> {
        let r = self.soap(ip, TOPOLOGY, "GetZoneGroupState", &[]).await?;
        let state = tag_text(&r, "ZoneGroupState").ok_or("no ZoneGroupState")?;
        Ok(parse_zone_groups(&xml_unescape(&state)))
    }

    pub async fn set_uri(&self, ip: IpAddr, uri: &str, meta: &str) -> Result<(), String> {
        self.soap(ip, AV_TRANSPORT, "SetAVTransportURI", &[("InstanceID", "0"), ("CurrentURI", uri), ("CurrentURIMetaData", meta)])
            .await
            .map(drop)
    }

    pub async fn play(&self, ip: IpAddr) -> Result<(), String> {
        self.soap(ip, AV_TRANSPORT, "Play", &[("InstanceID", "0"), ("Speed", "1")]).await.map(drop)
    }

    pub async fn pause(&self, ip: IpAddr) -> Result<(), String> {
        self.soap(ip, AV_TRANSPORT, "Pause", &[("InstanceID", "0")]).await.map(drop)
    }

    pub async fn stop(&self, ip: IpAddr) -> Result<(), String> {
        self.soap(ip, AV_TRANSPORT, "Stop", &[("InstanceID", "0")]).await.map(drop)
    }

    pub async fn seek(&self, ip: IpAddr, s: u32) -> Result<(), String> {
        let t = hms(s);
        self.soap(ip, AV_TRANSPORT, "Seek", &[("InstanceID", "0"), ("Unit", "REL_TIME"), ("Target", &t)]).await.map(drop)
    }

    /// `PLAYING`, `PAUSED_PLAYBACK`, `STOPPED` or `TRANSITIONING`.
    pub async fn transport_state(&self, ip: IpAddr) -> Result<String, String> {
        let r = self.soap(ip, AV_TRANSPORT, "GetTransportInfo", &[("InstanceID", "0")]).await?;
        tag_text(&r, "CurrentTransportState").ok_or_else(|| "no CurrentTransportState".into())
    }

    pub async fn position(&self, ip: IpAddr) -> Result<Position, String> {
        let r = self.soap(ip, AV_TRANSPORT, "GetPositionInfo", &[("InstanceID", "0")]).await?;
        Ok(Position {
            track_s: tag_text(&r, "TrackDuration").and_then(|t| parse_hms(&t)).unwrap_or(0),
            rel_s: tag_text(&r, "RelTime").and_then(|t| parse_hms(&t)).unwrap_or(0),
            uri: tag_text(&r, "TrackURI").map(|u| xml_unescape(&u)).unwrap_or_default(),
        })
    }

    pub async fn volume(&self, ip: IpAddr) -> Result<u8, String> {
        let r = self.soap(ip, RENDERING, "GetVolume", &[("InstanceID", "0"), ("Channel", "Master")]).await?;
        tag_text(&r, "CurrentVolume").and_then(|v| v.parse().ok()).ok_or_else(|| "no CurrentVolume".into())
    }

    pub async fn set_volume(&self, ip: IpAddr, v: u8) -> Result<(), String> {
        let v = v.min(100).to_string();
        self.soap(ip, RENDERING, "SetVolume", &[("InstanceID", "0"), ("Channel", "Master"), ("DesiredVolume", &v)]).await.map(drop)
    }
}

/// DIDL-Lite metadata so the Sonos app shows the title and channel.
pub fn didl(uri: &str, mime: &str, title: &str, creator: Option<&str>, duration_s: u32) -> String {
    let creator = creator.map(|c| format!("<dc:creator>{}</dc:creator>", xml_escape(c))).unwrap_or_default();
    format!(
        r#"<DIDL-Lite xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/" xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"><item id="-1" parentID="-1" restricted="true"><res protocolInfo="http-get:*:{mime}:*" duration="{}">{}</res><dc:title>{}</dc:title>{creator}<upnp:class>object.item.audioItem.musicTrack</upnp:class></item></DIDL-Lite>"#,
        hms(duration_s),
        xml_escape(uri),
        xml_escape(title),
    )
}

pub fn hms(s: u32) -> String {
    format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
}

/// `H:MM:SS` (Sonos sends `NOT_IMPLEMENTED` for streams; that is `None`).
pub fn parse_hms(t: &str) -> Option<u32> {
    let mut parts = t.split(':').map(|p| p.split('.').next().unwrap_or(p).parse::<u32>());
    let (h, m, s) = (parts.next()?.ok()?, parts.next()?.ok()?, parts.next()?.ok()?);
    Some(h * 3600 + m * 60 + s)
}

pub fn parse_zone_groups(xml: &str) -> Vec<Group> {
    let mut groups = Vec::new();
    for chunk in xml.split("<ZoneGroup ").skip(1) {
        let head = &chunk[..chunk.find('>').unwrap_or(chunk.len())];
        let Some(coordinator) = attr(head, "Coordinator") else { continue };
        let body = &chunk[..chunk.find("</ZoneGroup>").unwrap_or(chunk.len())];
        let mut members = Vec::new();
        for m in body.split("<ZoneGroupMember ").skip(1) {
            let tag = &m[..m.find('>').unwrap_or(m.len())];
            if attr(tag, "Invisible").as_deref() == Some("1") {
                continue;
            }
            let (Some(uuid), Some(loc)) = (attr(tag, "UUID"), attr(tag, "Location")) else { continue };
            let Some(ip) = host_of(&loc) else { continue };
            members.push((uuid, ip, attr(tag, "ZoneName").unwrap_or_default()));
        }
        groups.push(Group { coordinator, members });
    }
    groups
}

fn host_of(url: &str) -> Option<IpAddr> {
    let rest = url.strip_prefix("http://")?;
    let hostport = &rest[..rest.find('/').unwrap_or(rest.len())];
    hostport.parse::<SocketAddr>().map(|a| a.ip()).ok().or_else(|| hostport.parse().ok())
}

fn attr(tag: &str, name: &str) -> Option<String> {
    let pat = format!(" {name}=\"");
    let s = format!(" {tag}");
    let i = s.find(&pat)? + pat.len();
    let j = s[i..].find('"')?;
    Some(xml_unescape(&s[i..i + j]))
}

/// Text of the first `<tag>` or `<prefix:tag>` element (no nesting support).
fn tag_text(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let i = xml.find(&open)? + open.len();
    let j = xml[i..].find(&format!("</{tag}>"))?;
    Some(xml[i..i + j].to_string())
}

pub fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

pub fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hms_round_trip() {
        assert_eq!(hms(334), "0:05:34");
        assert_eq!(hms(3725), "1:02:05");
        assert_eq!(parse_hms("0:05:34"), Some(334));
        assert_eq!(parse_hms("1:02:05.500"), Some(3725));
        assert_eq!(parse_hms("NOT_IMPLEMENTED"), None);
    }

    #[test]
    fn zone_groups() {
        let xml = r#"<ZoneGroupState><ZoneGroups><ZoneGroup Coordinator="RINCON_A" ID="RINCON_A:1"><ZoneGroupMember UUID="RINCON_A" Location="http://192.168.1.20:1400/xml/device_description.xml" ZoneName="Kitchen"/><ZoneGroupMember UUID="RINCON_S" Location="http://192.168.1.21:1400/xml/device_description.xml" ZoneName="Kitchen" Invisible="1"/></ZoneGroup><ZoneGroup Coordinator="RINCON_B" ID="RINCON_B:2"><ZoneGroupMember UUID="RINCON_B" Location="http://192.168.1.30:1400/xml/device_description.xml" ZoneName="Den &amp; Office"/></ZoneGroup></ZoneGroups></ZoneGroupState>"#;
        let g = parse_zone_groups(xml);
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].coordinator, "RINCON_A");
        assert_eq!(g[0].members.len(), 1, "invisible satellite dropped");
        assert_eq!(g[1].members[0].1, "192.168.1.30".parse::<IpAddr>().unwrap());
        assert_eq!(g[1].members[0].2, "Den & Office");
    }

    #[test]
    fn didl_is_escaped() {
        let d = didl("http://h/stream/t?a=1&b=2", "audio/mp4", "Rock & <Roll>", Some("Chan"), 61);
        assert!(d.contains("http://h/stream/t?a=1&amp;b=2"));
        assert!(d.contains("Rock &amp; &lt;Roll&gt;"));
        assert!(d.contains(r#"duration="0:01:01""#));
        assert_eq!(xml_unescape(&xml_escape(&d)), d);
    }

    #[test]
    fn ssdp_reply() {
        assert!(is_sonos_reply("HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n"));
        assert!(!is_sonos_reply("HTTP/1.1 200 OK\r\nST: upnp:rootdevice\r\nSERVER: Linux UPnP/1.0 Roku\r\n"));
    }
}
