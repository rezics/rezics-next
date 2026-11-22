use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Write};
use std::num::NonZeroU32;

pub const FRAME_LIMIT: usize = 16_384;
pub const SESSION_FRAME_LIMIT: usize = 32_768;
const PANEL_LIMIT: usize = 8;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Shortcut {
    #[default]
    CtrlShiftSpace,
    CtrlShiftF9,
    CtrlShiftF10,
}

pub fn startup(args: &[String]) -> Result<(Option<u32>, Shortcut), &'static str> {
    let mut fixture = None;
    let mut shortcut = None;
    for pair in args.chunks(2) {
        match pair {
            [flag, value] if flag == "--fixture" && fixture.is_none() => {
                fixture = Some(
                    value
                        .parse::<u32>()
                        .map_err(|_| "invalid fixture process ID")?,
                );
            }
            [flag, value] if flag == "--shortcut" && shortcut.is_none() => {
                shortcut = Some(match value.as_str() {
                    "ctrl-shift-space" => Shortcut::CtrlShiftSpace,
                    "ctrl-shift-f9" => Shortcut::CtrlShiftF9,
                    "ctrl-shift-f10" => Shortcut::CtrlShiftF10,
                    _ => return Err("invalid Overlay shortcut"),
                });
            }
            _ => return Err("use --shortcut <preset> or --fixture <window process ID>"),
        }
    }
    Ok((fixture, shortcut.unwrap_or_default()))
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DestinationId {
    Info,
    Guide,
    Community,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Destination {
    id: DestinationId,
    label: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Panel {
    id: String,
    title: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    destination: Option<DestinationId>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Session {
    pub session_id: String,
    pub instance_id: String,
    pub pid: u32,
    pub title: String,
    pub started_at: u64,
    pub destinations: Vec<Destination>,
    #[serde(default)]
    pub panels: Vec<Panel>,
}

impl Session {
    pub fn allows_destination(&self, session_id: &str, destination: DestinationId) -> bool {
        self.session_id == session_id && self.destinations.iter().any(|link| link.id == destination)
    }
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum InputType {
    Session,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    v: u8,
    #[serde(rename = "type")]
    kind: InputType,
    #[serde(deserialize_with = "Deserialize::deserialize")]
    session: Option<Session>,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Output<'a> {
    Ready {
        v: u8,
        session_frame_limit: usize,
        shortcut: Shortcut,
    },
    HotkeyUnavailable {
        v: u8,
    },
    #[serde(rename = "webview2-unavailable")]
    WebView2Unavailable {
        v: u8,
        #[serde(skip_serializing_if = "Option::is_none")]
        runtime_detected: Option<bool>,
    },
    SessionStatus {
        v: u8,
        session_id: &'a str,
        attached: bool,
    },
    OpenDestination {
        v: u8,
        session_id: &'a str,
        destination: DestinationId,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelAction {
    pub session_id: String,
    pub interaction_id: NonZeroU32,
}

impl PanelAction {
    pub fn belongs_to(&self, session_id: &str, interaction_id: Option<NonZeroU32>) -> bool {
        self.session_id == session_id && Some(self.interaction_id) == interaction_id
    }
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum WebCommand {
    Ready,
    Hide {
        #[serde(flatten)]
        panel: PanelAction,
    },
    Hud {
        #[serde(flatten)]
        panel: PanelAction,
    },
    OpenDestination {
        #[serde(flatten)]
        panel: PanelAction,
        destination: DestinationId,
    },
}

impl WebCommand {
    pub fn panel(&self) -> Option<&PanelAction> {
        match self {
            Self::Ready => None,
            Self::Hide { panel } | Self::Hud { panel } | Self::OpenDestination { panel, .. } => {
                Some(panel)
            }
        }
    }
}

pub fn parse_web_command(message: &str) -> Option<WebCommand> {
    if message.len() > FRAME_LIMIT {
        return None;
    }
    serde_json::from_str(message).ok()
}

fn parse_input(frame: &[u8]) -> Option<Option<Session>> {
    let input: Input = serde_json::from_slice(frame).ok()?;
    if input.v != 1 || input.kind != InputType::Session {
        return None;
    }
    if let Some(session) = &input.session
        && (session.pid == 0
            || session.started_at == 0
            || session.session_id.trim().is_empty()
            || session.instance_id.trim().is_empty()
            || session.title.trim().is_empty()
            || session.panels.len() > PANEL_LIMIT)
    {
        return None;
    }
    Some(input.session)
}

pub fn read_sessions(
    mut reader: impl BufRead,
    mut on_session: impl FnMut(Option<Session>) -> bool,
) -> io::Result<()> {
    let mut frame = Vec::with_capacity(SESSION_FRAME_LIMIT);
    let mut overflow = false;
    loop {
        let bytes = reader.fill_buf()?;
        if bytes.is_empty() {
            return Ok(());
        }
        let newline = bytes.iter().position(|byte| *byte == b'\n');
        let end = newline.unwrap_or(bytes.len());
        overflow |= frame.len() + end > SESSION_FRAME_LIMIT;
        if !overflow {
            frame.extend_from_slice(&bytes[..end]);
        }
        reader.consume(end + usize::from(newline.is_some()));
        if newline.is_none() {
            continue;
        }
        if !overflow
            && let Some(session) = parse_input(&frame)
            && !on_session(session)
        {
            return Ok(());
        }
        overflow = false;
        frame.clear();
    }
}

pub fn write_message(mut writer: impl Write, message: Output<'_>) -> io::Result<()> {
    let mut frame = serde_json::to_vec(&message)?;
    if frame.len() > FRAME_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "overlay message exceeds the frame limit",
        ));
    }
    frame.push(b'\n');
    writer.write_all(&frame)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;

    const FIXTURE: &str = include_str!("../fixtures/session.jsonl");

    #[test]
    fn recovers_after_split_invalid_and_oversized_frames() {
        let (session, empty) = FIXTURE.trim().split_once('\n').unwrap();
        let bytes = [
            session.as_bytes(),
            b"\n",
            &vec![b'x'; SESSION_FRAME_LIMIT + 1],
            b"\n{\xff}\n",
            br#"{"v":1,"type":"session"}"#,
            b"\n",
            empty.as_bytes(),
            b"\n",
            session.as_bytes(),
        ]
        .concat();
        let mut received = Vec::new();
        read_sessions(BufReader::with_capacity(31, &bytes[..]), |session| {
            received.push(session);
            true
        })
        .unwrap();
        assert_eq!(received.len(), 2);
        let session = received[0].as_ref().unwrap();
        assert_eq!(session.instance_id, "game-1");
        assert_eq!(session.pid, 432);
        assert_eq!(session.started_at, 1_774_192_500_000);
        assert_eq!(session.title, "Fixture");
        assert_eq!(session.panels[0].destination, Some(DestinationId::Guide));
        assert!(received[1].is_none());
    }

    #[test]
    fn session_frames_fit_eight_escaped_panels_and_keep_the_action_limit() {
        let mut input: serde_json::Value =
            serde_json::from_str(FIXTURE.lines().next().unwrap()).unwrap();
        let panels = (0..PANEL_LIMIT)
            .map(|index| {
                serde_json::json!({
                    "id": format!("fixture.panel-{index}"),
                    "title": "\u{0001}".repeat(64),
                    "text": "\u{0001}".repeat(400),
                    "destination": "guide",
                })
            })
            .collect::<Vec<_>>();
        input["session"]["panels"] = serde_json::Value::Array(panels);
        let line = format!("{input}\n");
        assert!(line.len() > FRAME_LIMIT && line.len() <= SESSION_FRAME_LIMIT);
        let mut received = Vec::new();
        read_sessions(BufReader::with_capacity(37, line.as_bytes()), |session| {
            received.push(session.unwrap());
            true
        })
        .unwrap();
        assert_eq!(received[0].panels.len(), PANEL_LIMIT);
        assert_eq!(received[0].panels[PANEL_LIMIT - 1].text.len(), 400);

        let records = input["session"]["panels"].as_array_mut().unwrap();
        records.push(records[0].clone());
        assert!(parse_input(input.to_string().as_bytes()).is_none());
        let command = format!(
            r#"{{"type":"hide","sessionId":"{}"}}"#,
            "x".repeat(FRAME_LIMIT)
        );
        assert!(parse_web_command(&command).is_none());
    }

    #[test]
    fn panel_actions_are_bound_to_the_current_session_and_opening() {
        let first_frame = FIXTURE.lines().next().unwrap();
        let session = parse_input(first_frame.as_bytes()).unwrap().unwrap();
        let opening = NonZeroU32::new(9);
        let frame = r#"{"type":"open-destination","sessionId":"launch-1","interactionId":9,"destination":"guide"}"#;
        let Some(WebCommand::OpenDestination { panel, destination }) = parse_web_command(frame)
        else {
            panic!("expected a destination command");
        };
        assert!(panel.belongs_to(&session.session_id, opening));
        assert!(session.allows_destination(&panel.session_id, destination));
        assert!(!session.allows_destination("expired-session", destination));
        assert!(!session.allows_destination(&panel.session_id, DestinationId::Community));
        assert!(!panel.belongs_to(&session.session_id, NonZeroU32::new(10)));
        assert!(matches!(
            parse_web_command(r#"{"type":"hud","sessionId":"launch-1","interactionId":9}"#),
            Some(WebCommand::Hud { panel }) if panel.belongs_to(&session.session_id, opening)
        ));
        assert!(matches!(
            parse_web_command(r#"{"type":"hide","sessionId":"launch-1","interactionId":9}"#),
            Some(WebCommand::Hide { panel }) if panel.belongs_to(&session.session_id, opening)
        ));
        for kind in ["hide", "hud", "open-destination"] {
            let frame = format!(
                r#"{{"type":"{kind}","sessionId":"launch-1","interactionId":9,"destination":"guide"}}"#
            );
            let action = parse_web_command(&frame).unwrap();
            let panel = action.panel().unwrap();
            assert!(!panel.belongs_to(&session.session_id, None));
            assert!(!panel.belongs_to(&session.session_id, NonZeroU32::new(10)));
            assert!(!panel.belongs_to("another-session", opening));
        }
        assert!(parse_web_command(r#"{"type":"hide","sessionId":"launch-1"}"#).is_none());
        assert!(
            parse_web_command(r#"{"type":"hide","sessionId":"launch-1","interactionId":0}"#)
                .is_none()
        );
    }

    #[test]
    fn accepts_only_named_shortcut_presets_and_one_fixture() {
        let parse =
            |args: &[&str]| startup(&args.iter().map(|arg| (*arg).into()).collect::<Vec<_>>());
        assert_eq!(parse(&[]), Ok((None, Shortcut::CtrlShiftSpace)));
        assert_eq!(
            parse(&["--fixture", "123", "--shortcut", "ctrl-shift-f9"]),
            Ok((Some(123), Shortcut::CtrlShiftF9))
        );
        assert!(parse(&["--shortcut", "ctrl-shift-f12"]).is_err());
        assert!(
            parse(&[
                "--shortcut",
                "ctrl-shift-f10",
                "--shortcut",
                "ctrl-shift-space"
            ])
            .is_err()
        );
    }

    #[test]
    fn writes_exact_newline_delimited_messages() {
        let mut bytes = Vec::new();
        write_message(
            &mut bytes,
            Output::Ready {
                v: 1,
                session_frame_limit: SESSION_FRAME_LIMIT,
                shortcut: Shortcut::CtrlShiftF10,
            },
        )
        .unwrap();
        write_message(&mut bytes, Output::HotkeyUnavailable { v: 1 }).unwrap();
        for runtime_detected in [None, Some(true)] {
            write_message(
                &mut bytes,
                Output::WebView2Unavailable {
                    v: 1,
                    runtime_detected,
                },
            )
            .unwrap();
        }
        write_message(
            &mut bytes,
            Output::SessionStatus {
                v: 1,
                session_id: "launch-1",
                attached: false,
            },
        )
        .unwrap();
        write_message(
            &mut bytes,
            Output::OpenDestination {
                v: 1,
                session_id: "launch-1",
                destination: DestinationId::Guide,
            },
        )
        .unwrap();
        assert_eq!(
            String::from_utf8(bytes).unwrap(),
            concat!(
                "{\"type\":\"ready\",\"v\":1,\"sessionFrameLimit\":32768,\"shortcut\":\"ctrl-shift-f10\"}\n",
                "{\"type\":\"hotkey-unavailable\",\"v\":1}\n",
                "{\"type\":\"webview2-unavailable\",\"v\":1}\n",
                "{\"type\":\"webview2-unavailable\",\"v\":1,\"runtimeDetected\":true}\n",
                "{\"type\":\"session-status\",\"v\":1,\"sessionId\":\"launch-1\",\"attached\":false}\n",
                "{\"type\":\"open-destination\",\"v\":1,\"sessionId\":\"launch-1\",\"destination\":\"guide\"}\n"
            )
        );
    }
}
