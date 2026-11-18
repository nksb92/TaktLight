pub mod expander;
pub mod library;
pub mod matrix;
pub mod model;
pub mod validator;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum OflError {
    #[error("OFL JSON parse error: {0}")]
    JsonParse(#[from] serde_json::Error),

    #[error("OFL schema validation failed with {0} issue(s)")]
    SchemaValidation(usize),

    #[error("mode '{0}' not found in fixture")]
    ModeNotFound(String),

    #[error("channel '{0}' referenced in mode not found in availableChannels")]
    ChannelNotFound(String),

    #[error("template channel '{0}' not found in templateChannels")]
    TemplateChannelNotFound(String),

    #[error("fixture uses matrixChannels insert but has no matrix definition")]
    MissingMatrix,

    #[error("pixel group '{0}' not found in matrix.pixelGroups")]
    PixelGroupNotFound(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}
