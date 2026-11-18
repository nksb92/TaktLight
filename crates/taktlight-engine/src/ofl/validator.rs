use std::error::Error;
use std::sync::OnceLock;

use jsonschema::{Draft, Retrieve, Uri, Validator};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const OFL_SCHEMA_BASE_URL: &str =
    "https://raw.githubusercontent.com/OpenLightingProject/open-fixture-library/master/schemas/";

pub const OFL_SCHEMA_FIXTURE: &str = include_str!("../../schemas/ofl/fixture.json");
pub const OFL_SCHEMA_DEFINITIONS: &str = include_str!("../../schemas/ofl/definitions.json");
pub const OFL_SCHEMA_CAPABILITY: &str = include_str!("../../schemas/ofl/capability.json");
pub const OFL_SCHEMA_CHANNEL: &str = include_str!("../../schemas/ofl/channel.json");
pub const OFL_SCHEMA_MATRIX: &str = include_str!("../../schemas/ofl/matrix.json");
pub const OFL_SCHEMA_WHEEL_SLOT: &str = include_str!("../../schemas/ofl/wheel-slot.json");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchemaValidationIssue {
    pub instance_path: String,
    pub schema_path: String,
    pub message: String,
}

pub struct OfflineOflRetriever;

impl OfflineOflRetriever {
    fn resolve_embedded(uri_str: &str) -> Option<&'static str> {
        let base_stripped = uri_str
            .split('#')
            .next()
            .unwrap_or(uri_str)
            .strip_prefix(OFL_SCHEMA_BASE_URL)
            .unwrap_or_else(|| uri_str.split('#').next().unwrap_or(uri_str));

        match base_stripped {
            "fixture.json" => Some(OFL_SCHEMA_FIXTURE),
            "definitions.json" => Some(OFL_SCHEMA_DEFINITIONS),
            "capability.json" => Some(OFL_SCHEMA_CAPABILITY),
            "channel.json" => Some(OFL_SCHEMA_CHANNEL),
            "matrix.json" => Some(OFL_SCHEMA_MATRIX),
            "wheel-slot.json" => Some(OFL_SCHEMA_WHEEL_SLOT),
            _ => None,
        }
    }
}

impl Retrieve for OfflineOflRetriever {
    fn retrieve(&self, uri: &Uri<String>) -> Result<Value, Box<dyn Error + Send + Sync>> {
        let s = uri.as_str();
        let raw = Self::resolve_embedded(s)
            .ok_or_else(|| format!("offline schema retriever blocked external URI: {s}"))?;
        let parsed: Value = serde_json::from_str(raw)?;
        Ok(parsed)
    }
}

static OFL_VALIDATOR: OnceLock<Validator> = OnceLock::new();

pub fn ofl_validator() -> &'static Validator {
    OFL_VALIDATOR.get_or_init(|| {
        let root: Value =
            serde_json::from_str(OFL_SCHEMA_FIXTURE).expect("embedded fixture.json valid");
        jsonschema::options()
            .with_draft(Draft::Draft7)
            .with_retriever(OfflineOflRetriever)
            .build(&root)
            .expect("embedded OFL schema compiles")
    })
}

pub fn validate_ofl_value(value: &Value) -> Result<(), Vec<SchemaValidationIssue>> {
    let issues: Vec<SchemaValidationIssue> = ofl_validator()
        .iter_errors(value)
        .map(|err| {
            let instance_path = err.instance_path.to_string();
            SchemaValidationIssue {
                instance_path: if instance_path.is_empty() {
                    "/".to_string()
                } else {
                    instance_path
                },
                schema_path: err.schema_path.to_string(),
                message: err.to_string(),
            }
        })
        .collect();

    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}

pub fn validate_ofl_json_str(raw_json: &str) -> Result<Value, Vec<SchemaValidationIssue>> {
    let value: Value = match serde_json::from_str(raw_json) {
        Ok(v) => v,
        Err(e) => {
            return Err(vec![SchemaValidationIssue {
                instance_path: "/".to_string(),
                schema_path: "".to_string(),
                message: format!("invalid JSON syntax: {e}"),
            }]);
        }
    };

    validate_ofl_value(&value)?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RLCV3_FIXTURE_JSON: &str = r#"{
      "$schema": "https://raw.githubusercontent.com/OpenLightingProject/open-fixture-library/master/schemas/fixture.json",
      "name": "RLCV3 8-Segment RGBW Tube",
      "shortName": "RLCV3-8Px",
      "categories": ["Pixel Bar", "Color Changer"],
      "meta": {
        "authors": ["Another German Engineer"],
        "createDate": "2026-11-17",
        "lastModifyDate": "2026-11-18"
      },
      "matrix": {
        "pixelCount": [8, 1, 1],
        "pixelGroups": {
          "All": "all"
        }
      },
      "availableChannels": {
        "Master Dimmer": {
          "defaultValue": 0,
          "capability": { "type": "Intensity" }
        },
        "Strobe": {
          "defaultValue": 0,
          "capabilities": [
            { "dmxRange": [0, 7], "type": "ShutterStrobe", "shutterEffect": "Closed" },
            { "dmxRange": [8, 15], "type": "ShutterStrobe", "shutterEffect": "Open" },
            { "dmxRange": [16, 200], "type": "ShutterStrobe", "shutterEffect": "Strobe", "speedStart": "1Hz", "speedEnd": "20Hz" },
            { "dmxRange": [201, 255], "type": "ShutterStrobe", "shutterEffect": "Strobe", "randomTiming": true, "speedStart": "1Hz", "speedEnd": "20Hz" }
          ]
        }
      },
      "templateChannels": {
        "Red $pixelKey": {
          "defaultValue": 0,
          "capability": { "type": "ColorIntensity", "color": "Red" }
        },
        "Green $pixelKey": {
          "defaultValue": 0,
          "capability": { "type": "ColorIntensity", "color": "Green" }
        },
        "Blue $pixelKey": {
          "defaultValue": 0,
          "capability": { "type": "ColorIntensity", "color": "Blue" }
        },
        "White $pixelKey": {
          "defaultValue": 0,
          "capability": { "type": "ColorIntensity", "color": "White" }
        }
      },
      "modes": [
        {
          "name": "34ch Pixel Mode",
          "shortName": "34ch",
          "channels": [
            "Master Dimmer",
            "Strobe",
            {
              "insert": "matrixChannels",
              "repeatFor": "eachPixelABC",
              "channelOrder": "perPixel",
              "templateChannels": [
                "Red $pixelKey",
                "Green $pixelKey",
                "Blue $pixelKey",
                "White $pixelKey"
              ]
            }
          ]
        }
      ]
    }"#;

    #[test]
    fn valid_rlcv3_ofl_fixture_passes_offline_schema_validation() {
        let parsed = validate_ofl_json_str(RLCV3_FIXTURE_JSON).expect("RLCV3 fixture valid");
        assert_eq!(parsed["name"], "RLCV3 8-Segment RGBW Tube");
    }

    #[test]
    fn invalid_dmx_range_color_and_missing_modes_are_rejected_with_json_paths() {
        let bad_range = RLCV3_FIXTURE_JSON.replace("[0, 7]", "[0, 300]");
        let issues = validate_ofl_json_str(&bad_range).unwrap_err();
        assert!(
            issues.iter().any(|i| i
                .instance_path
                .contains("/availableChannels/Strobe/capabilities/0/dmxRange")),
            "expected dmxRange path in {:?}",
            issues
        );

        let bad_color = RLCV3_FIXTURE_JSON.replace("\"Red\"", "\"Infrared\"");
        let color_issues = validate_ofl_json_str(&bad_color).unwrap_err();
        assert!(
            color_issues.iter().any(|i| i
                .instance_path
                .contains("/templateChannels/Red $pixelKey/capability/color")),
            "expected color path in {:?}",
            color_issues
        );

        let missing_modes = r#"{
          "name": "Broken",
          "categories": ["Color Changer"],
          "meta": {
            "authors": ["Test"],
            "createDate": "2026-11-18",
            "lastModifyDate": "2026-11-18"
          },
          "availableChannels": {
            "Dimmer": { "capability": { "type": "Intensity" } }
          }
        }"#;
        let issues2 = validate_ofl_json_str(missing_modes).unwrap_err();
        assert!(!issues2.is_empty());

        let empty_channels = r#"{
          "name": "EmptyChannels",
          "categories": ["Color Changer"],
          "meta": {
            "authors": ["Test"],
            "createDate": "2026-11-18",
            "lastModifyDate": "2026-11-18"
          },
          "availableChannels": {
            "Dimmer": { "capability": { "type": "Intensity" } }
          },
          "modes": [
            { "name": "Empty", "channels": [] }
          ]
        }"#;
        let issues3 = validate_ofl_json_str(empty_channels).unwrap_err();
        assert!(
            issues3
                .iter()
                .any(|i| i.instance_path.contains("/modes/0/channels")),
            "expected empty channels path in {:?}",
            issues3
        );
    }

    #[test]
    fn offline_retriever_rejects_external_uris() {
        let uri = jsonschema::Uri::parse("https://example.com/evil.json".to_string()).unwrap();
        assert!(OfflineOflRetriever.retrieve(&uri).is_err());
    }
}
