pub mod compiler;
pub mod patch;
pub mod spatial;
pub mod targets;
pub mod undo;
pub mod xml;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum ShowError {
    #[error("invalid order rule: '{0}'")]
    InvalidOrderRule(String),

    #[error("invalid target reference: '{0}'")]
    InvalidTargetRef(String),

    #[error("DMX address collision on universe {universe} channel {address} (fixture '{existing_id}')")]
    AddressCollision {
        universe: u16,
        address: u16,
        existing_id: String,
    },

    #[error("invalid DMX address {0}: expected 1..=512")]
    InvalidDmxAddress(u16),

    #[error("invalid channel footprint {0}: expected 1..=512")]
    InvalidChannelCount(u16),

    #[error("fixture '{0}' not found in patch")]
    FixtureNotFound(String),

    #[error("duplicate fixture id '{0}'")]
    DuplicateFixtureId(String),

    #[error("profile '{0}' or mode '{1}' not found in OFL library")]
    ProfileOrModeNotFound(String, String),

    #[error("missing target_group on both container and FX block '{0}'")]
    MissingTargetGroup(String),

    #[error("show file is read-only (schema version '{0}' is newer than supported '1.0')")]
    ReadOnlyNewerSchema(String),

    #[error("XML error: {0}")]
    Xml(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}
