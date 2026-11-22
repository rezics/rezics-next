use serde::Serialize;
use std::num::NonZeroU32;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Visibility {
    #[default]
    Hidden,
    Hud,
    #[serde(rename = "hidden")]
    SuspendedHud,
    Interactive,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Foreground {
    Game,
    Overlay,
    Other,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct PanelOpening(u32);

impl PanelOpening {
    pub fn start(&mut self) {
        self.0 = self.0.wrapping_add(1).max(1);
    }

    pub fn current(self, mode: Visibility) -> Option<NonZeroU32> {
        if mode == Visibility::Interactive {
            NonZeroU32::new(self.0)
        } else {
            None
        }
    }
}

impl Visibility {
    pub fn closes_on_focus_loss(self, overlay_is_foreground: bool) -> bool {
        self == Self::Interactive && !overlay_is_foreground
    }

    pub fn accepts_foreground(self, foreground: Foreground) -> bool {
        matches!(
            (self, foreground),
            (Self::Hud | Self::SuspendedHud, Foreground::Game)
                | (Self::Interactive, Foreground::Overlay)
        )
    }

    pub fn is_visible(self) -> bool {
        matches!(self, Self::Hud | Self::Interactive)
    }

    pub fn can_open_interactive(self, pinned_window_is_foreground: bool) -> bool {
        self == Self::Hidden
            || (matches!(self, Self::Hud | Self::SuspendedHud) && pinned_window_is_foreground)
    }

    pub fn after_tracking(self, target_alive: bool, positioned: bool) -> Self {
        match (self, target_alive, positioned) {
            (Self::Hud | Self::SuspendedHud, true, true) => Self::Hud,
            (Self::Hud | Self::SuspendedHud, true, false) => Self::SuspendedHud,
            (Self::Interactive, true, true) => Self::Interactive,
            _ => Self::Hidden,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreground_must_match_the_input_mode() {
        assert!(Visibility::Interactive.accepts_foreground(Foreground::Overlay));
        assert!(!Visibility::Interactive.accepts_foreground(Foreground::Game));
        assert!(!Visibility::Interactive.accepts_foreground(Foreground::Other));
        for mode in [Visibility::Hud, Visibility::SuspendedHud] {
            assert!(mode.accepts_foreground(Foreground::Game));
            assert!(!mode.accepts_foreground(Foreground::Overlay));
            assert!(!mode.accepts_foreground(Foreground::Other));
        }
        assert!(!Visibility::Hidden.accepts_foreground(Foreground::Game));
    }

    #[test]
    fn only_the_pinned_hud_can_resume_when_the_same_target_returns() {
        let suspended = Visibility::Hud.after_tracking(true, false);
        assert_eq!(suspended, Visibility::SuspendedHud);
        assert!(!suspended.is_visible());
        assert_eq!(serde_json::to_string(&suspended).unwrap(), "\"hidden\"");
        assert_eq!(suspended.after_tracking(true, false), suspended);
        assert_eq!(suspended.after_tracking(true, true), Visibility::Hud);
        assert_eq!(suspended.after_tracking(false, false), Visibility::Hidden);
        assert!(Visibility::Hud.is_visible());
        assert_eq!(
            Visibility::Hud.after_tracking(false, false),
            Visibility::Hidden
        );
        assert_eq!(
            Visibility::Interactive.after_tracking(true, false),
            Visibility::Hidden
        );
        assert_eq!(
            Visibility::Hidden.after_tracking(true, true),
            Visibility::Hidden
        );
    }

    #[test]
    fn hotkey_reopens_a_pinned_hud_only_on_its_window() {
        assert!(Visibility::Hidden.can_open_interactive(false));
        for mode in [Visibility::Hud, Visibility::SuspendedHud] {
            assert!(mode.can_open_interactive(true));
            assert!(!mode.can_open_interactive(false));
        }
    }

    #[test]
    fn reopening_an_interaction_retires_every_action_from_the_previous_view() {
        let mut opening = PanelOpening::default();
        assert_eq!(opening.current(Visibility::Interactive), None);
        opening.start();
        let old = opening.current(Visibility::Interactive).unwrap();
        assert_eq!(opening.current(Visibility::Hud), None);
        assert_eq!(opening.current(Visibility::SuspendedHud), None);
        assert_eq!(opening.current(Visibility::Hidden), None);
        opening.start();
        assert_ne!(opening.current(Visibility::Interactive).unwrap(), old);
    }

    #[test]
    fn focus_moving_inside_the_overlay_does_not_close_it() {
        assert!(!Visibility::Interactive.closes_on_focus_loss(true));
        assert!(Visibility::Interactive.closes_on_focus_loss(false));
        assert!(!Visibility::Hud.closes_on_focus_loss(false));
    }
}
