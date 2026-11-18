use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::expander::{expand_all_modes, ExpandedFixtureMode};
use super::model::OflFixtureDefinition;
use super::validator::{validate_ofl_json_str, SchemaValidationIssue};

const EMBEDDED_RLCV3_JSON: &str =
    include_str!("../../../../fixtures/age/rlcv3_8_segment_tube.json");
const EMBEDDED_RLCV4_JSON: &str =
    include_str!("../../../../fixtures/age/rlcv4_16_segment_tube.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FixtureOrigin {
    AgeBuiltIn,
    UserLocal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FixtureModeSummary {
    pub name: String,
    pub short_name: String,
    pub channel_count: usize,
    pub cell_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FixtureSummary {
    pub id: String,
    pub name: String,
    pub short_name: String,
    pub origin: FixtureOrigin,
    pub categories: Vec<String>,
    pub pixel_count: u16,
    pub modes: Vec<FixtureModeSummary>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FixtureDetail {
    pub summary: FixtureSummary,
    pub raw_json: String,
    pub definition: OflFixtureDefinition,
    pub expanded_modes: Vec<ExpandedFixtureMode>,
}

#[derive(Debug, Error)]
pub enum SaveFixtureError {
    #[error("invalid fixture slug")]
    InvalidSlug,
    #[error("schema validation failed")]
    Validation(Vec<SchemaValidationIssue>),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

pub fn validate_and_parse_ofl(
    raw_json: &str,
) -> Result<(OflFixtureDefinition, Vec<ExpandedFixtureMode>), Vec<SchemaValidationIssue>> {
    let val = validate_ofl_json_str(raw_json)?;
    let def: OflFixtureDefinition = serde_json::from_value(val).map_err(|e| {
        vec![SchemaValidationIssue {
            instance_path: "/".to_string(),
            schema_path: "".to_string(),
            message: format!("OFL structure error: {e}"),
        }]
    })?;

    let expanded_modes = expand_all_modes(&def).map_err(|e| {
        vec![SchemaValidationIssue {
            instance_path: "/modes".to_string(),
            schema_path: "".to_string(),
            message: e.to_string(),
        }]
    })?;

    Ok((def, expanded_modes))
}

pub fn sanitize_fixture_slug(raw: &str) -> Option<String> {
    let stripped = raw.strip_suffix(".json").unwrap_or(raw);
    let mut slug = String::with_capacity(stripped.len());
    let mut prev_underscore = false;

    for ch in stripped.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            slug.push(lower);
            prev_underscore = false;
        } else if (lower == '_' || lower == '-' || lower == ' ') && !prev_underscore && !slug.is_empty() {
            slug.push('_');
            prev_underscore = true;
        }
    }

    while slug.ends_with('_') {
        slug.pop();
    }

    if slug.is_empty() {
        None
    } else {
        Some(slug)
    }
}

fn build_detail(
    id: String,
    origin: FixtureOrigin,
    raw_json: String,
    definition: OflFixtureDefinition,
    expanded_modes: Vec<ExpandedFixtureMode>,
) -> FixtureDetail {
    let pixel_count = expanded_modes
        .iter()
        .map(|m| m.cells.len() as u16)
        .max()
        .unwrap_or(1);

    let mode_summaries = expanded_modes
        .iter()
        .map(|m| FixtureModeSummary {
            name: m.name.clone(),
            short_name: m.short_name.clone(),
            channel_count: m.channel_count,
            cell_count: m.cells.len(),
        })
        .collect();

    let short_name = definition
        .short_name
        .clone()
        .unwrap_or_else(|| definition.name.clone());

    let summary = FixtureSummary {
        id,
        name: definition.name.clone(),
        short_name,
        origin,
        categories: definition.categories.clone(),
        pixel_count,
        modes: mode_summaries,
    };

    FixtureDetail {
        summary,
        raw_json,
        definition,
        expanded_modes,
    }
}

#[derive(Debug, Default)]
pub struct FixtureLibrary {
    root_dir: Option<PathBuf>,
    entries: BTreeMap<String, FixtureDetail>,
}

impl FixtureLibrary {
    pub fn load(root_dir: Option<&Path>) -> Self {
        let mut lib = Self {
            root_dir: root_dir.map(Path::to_path_buf),
            entries: BTreeMap::new(),
        };

        // Always load shipped AGE profiles from compile-time embeds first
        for (id, raw) in [
            ("age/rlcv3_8_segment_tube.json", EMBEDDED_RLCV3_JSON),
            ("age/rlcv4_16_segment_tube.json", EMBEDDED_RLCV4_JSON),
        ] {
            if let Ok((def, modes)) = validate_and_parse_ofl(raw) {
                lib.entries.insert(
                    id.to_string(),
                    build_detail(
                        id.to_string(),
                        FixtureOrigin::AgeBuiltIn,
                        raw.to_string(),
                        def,
                        modes,
                    ),
                );
            }
        }

        if let Some(root) = root_dir {
            lib.load_folder(&root.join("age"), "age", FixtureOrigin::AgeBuiltIn);
            lib.load_folder(&root.join("user"), "user", FixtureOrigin::UserLocal);
        }

        lib
    }

    fn load_folder(&mut self, dir: &Path, prefix: &str, origin: FixtureOrigin) {
        let Ok(read_dir) = fs::read_dir(dir) else {
            return;
        };

        for entry in read_dir.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let Some(file_name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            let Ok(raw) = fs::read_to_string(&path) else {
                continue;
            };
            if let Ok((def, modes)) = validate_and_parse_ofl(&raw) {
                let id = format!("{prefix}/{file_name}");
                self.entries.insert(
                    id.clone(),
                    build_detail(id, origin, raw, def, modes),
                );
            }
        }
    }

    pub fn list_summaries(&self) -> Vec<FixtureSummary> {
        self.entries.values().map(|d| d.summary.clone()).collect()
    }

    pub fn get_entry(&self, id: &str) -> Option<&FixtureDetail> {
        self.entries.get(id)
    }

    pub fn save_user_fixture(
        &mut self,
        slug_or_name: &str,
        raw_json: &str,
    ) -> Result<FixtureDetail, SaveFixtureError> {
        let slug = sanitize_fixture_slug(slug_or_name).ok_or(SaveFixtureError::InvalidSlug)?;
        let (def, modes) =
            validate_and_parse_ofl(raw_json).map_err(SaveFixtureError::Validation)?;

        let formatted_json = serde_json::from_str::<serde_json::Value>(raw_json)
            .and_then(|v| serde_json::to_string_pretty(&v))
            .unwrap_or_else(|_| raw_json.to_string());
        let file_name = format!("{slug}.json");
        let id = format!("user/{file_name}");

        if let Some(root) = &self.root_dir {
            let user_dir = root.join("user");
            fs::create_dir_all(&user_dir)?;
            fs::write(user_dir.join(&file_name), &formatted_json)?;
        }

        let detail = build_detail(
            id.clone(),
            FixtureOrigin::UserLocal,
            formatted_json,
            def,
            modes,
        );
        self.entries.insert(id, detail.clone());
        Ok(detail)
    }

    pub fn delete_user_fixture(&mut self, id: &str) -> Result<(), String> {
        let Some(existing) = self.entries.get(id) else {
            return Err(format!("fixture '{id}' not found"));
        };
        if existing.summary.origin != FixtureOrigin::UserLocal {
            return Err("built-in AGE profiles cannot be deleted".to_string());
        }
        if let Some(root) = &self.root_dir {
            if let Some(file_name) = id.strip_prefix("user/") {
                let path = root.join("user").join(file_name);
                if path.exists() {
                    fs::remove_file(path).map_err(|e| e.to_string())?;
                }
            }
        }
        self.entries.remove(id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_shipped_rlcv3_and_rlcv4_profiles_only() {
        let lib = FixtureLibrary::load(None);
        let summaries = lib.list_summaries();
        assert_eq!(summaries.len(), 2);

        let rlcv3 = lib.get_entry("age/rlcv3_8_segment_tube.json").unwrap();
        assert_eq!(rlcv3.summary.pixel_count, 8);
        assert_eq!(rlcv3.expanded_modes[0].channel_count, 34);

        let rlcv4 = lib.get_entry("age/rlcv4_16_segment_tube.json").unwrap();
        assert_eq!(rlcv4.summary.pixel_count, 16);
        assert_eq!(rlcv4.expanded_modes[0].channel_count, 66);
    }

    #[test]
    fn saves_reloads_and_deletes_user_fixture_in_local_folder() {
        let temp_dir = std::env::temp_dir().join(format!(
            "taktlight_ofl_test_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&temp_dir);

        let custom_json = r#"{
          "$schema": "https://raw.githubusercontent.com/OpenLightingProject/open-fixture-library/master/schemas/fixture.json",
          "name": "Custom Studio Par",
          "shortName": "StudioPar",
          "categories": ["Color Changer"],
          "meta": { "authors": ["User"], "createDate": "2026-11-18", "lastModifyDate": "2026-11-18" },
          "availableChannels": {
            "Dimmer": { "defaultValue": 0, "capability": { "type": "Intensity" } },
            "Red": { "defaultValue": 0, "capability": { "type": "ColorIntensity", "color": "Red" } },
            "Green": { "defaultValue": 0, "capability": { "type": "ColorIntensity", "color": "Green" } },
            "Blue": { "defaultValue": 0, "capability": { "type": "ColorIntensity", "color": "Blue" } }
          },
          "modes": [
            { "name": "4ch RGBD", "shortName": "4ch", "channels": ["Dimmer", "Red", "Green", "Blue"] }
          ]
        }"#;

        let mut lib = FixtureLibrary::load(Some(&temp_dir));
        let saved = lib.save_user_fixture("Custom Studio Par", custom_json).unwrap();
        assert_eq!(saved.summary.id, "user/custom_studio_par.json");
        assert!(temp_dir.join("user/custom_studio_par.json").exists());

        // Reload from disk
        let lib2 = FixtureLibrary::load(Some(&temp_dir));
        assert!(lib2.get_entry("user/custom_studio_par.json").is_some());

        // Cannot delete built-in profile
        assert!(lib.delete_user_fixture("age/rlcv3_8_segment_tube.json").is_err());

        // Delete user profile
        lib.delete_user_fixture("user/custom_studio_par.json").unwrap();
        assert!(!temp_dir.join("user/custom_studio_par.json").exists());

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn rejects_mode_referencing_missing_channel() {
        let broken_ref = r#"{
          "name": "Missing Channel Ref",
          "categories": ["Dimmer"],
          "meta": { "authors": ["User"], "createDate": "2026-11-18", "lastModifyDate": "2026-11-18" },
          "availableChannels": {
            "Dimmer": { "capability": { "type": "Intensity" } }
          },
          "modes": [
            { "name": "Broken", "channels": ["Dimmer", "NonExistent"] }
          ]
        }"#;
        let err = validate_and_parse_ofl(broken_ref).unwrap_err();
        assert_eq!(err[0].instance_path, "/modes");
    }
}
