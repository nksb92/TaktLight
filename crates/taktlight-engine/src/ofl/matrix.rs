use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::model::{OflMatrix, OflRepeatFor};
use super::OflError;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MatrixCell {
    pub cell_index: u16,
    pub pixel_key: String,
    pub grid_xyz: [u16; 3],
    pub local_uv: [f32; 2],
}

fn axis_uv(idx: u16, count: u16) -> f32 {
    if count <= 1 {
        0.0
    } else {
        (idx as f32) / ((count - 1) as f32) - 0.5
    }
}

fn format_pixel_key(x: u16, y: u16, z: u16, nx: u16, ny: u16, nz: u16) -> String {
    if nx <= 1 && ny <= 1 && nz <= 1 {
        "1".to_string()
    } else if ny == 1 && nz == 1 {
        format!("{}", x + 1)
    } else if nx == 1 && nz == 1 {
        format!("{}", y + 1)
    } else if nx == 1 && ny == 1 {
        format!("{}", z + 1)
    } else if nz == 1 {
        format!("{}-{}", x + 1, y + 1)
    } else {
        format!("{}-{}-{}", x + 1, y + 1, z + 1)
    }
}

fn expand_from_pixel_keys(val: &Value) -> Result<Vec<MatrixCell>, OflError> {
    let arr = val.as_array().ok_or(OflError::MissingMatrix)?;
    if arr.is_empty() {
        return Err(OflError::MissingMatrix);
    }

    // Determine nesting depth (1D, 2D, or 3D)
    let first = &arr[0];
    let mut raw_entries: Vec<(u16, u16, u16, String)> = Vec::new();
    let mut max_x: u16 = 1;
    let mut max_y: u16 = 1;

    if first.is_array() {
        let inner = first.as_array().unwrap();
        if inner.first().is_some_and(|v| v.is_array()) {
            // 3D: [z][y][x]
            for (z_idx, z_val) in arr.iter().enumerate() {
                if let Some(y_arr) = z_val.as_array() {
                    max_y = max_y.max(y_arr.len() as u16);
                    for (y_idx, y_val) in y_arr.iter().enumerate() {
                        if let Some(x_arr) = y_val.as_array() {
                            max_x = max_x.max(x_arr.len() as u16);
                            for (x_idx, x_val) in x_arr.iter().enumerate() {
                                if let Some(key) = x_val.as_str() {
                                    raw_entries.push((
                                        x_idx as u16,
                                        y_idx as u16,
                                        z_idx as u16,
                                        key.to_string(),
                                    ));
                                }
                            }
                        }
                    }
                }
            }
        } else {
            // 2D: [y][x]
            max_y = arr.len() as u16;
            for (y_idx, y_val) in arr.iter().enumerate() {
                if let Some(x_arr) = y_val.as_array() {
                    max_x = max_x.max(x_arr.len() as u16);
                    for (x_idx, x_val) in x_arr.iter().enumerate() {
                        if let Some(key) = x_val.as_str() {
                            raw_entries.push((x_idx as u16, y_idx as u16, 0, key.to_string()));
                        }
                    }
                }
            }
        }
    } else {
        // 1D: [x]
        max_x = arr.len() as u16;
        for (x_idx, x_val) in arr.iter().enumerate() {
            if let Some(key) = x_val.as_str() {
                raw_entries.push((x_idx as u16, 0, 0, key.to_string()));
            }
        }
    }

    if raw_entries.is_empty() {
        return Err(OflError::MissingMatrix);
    }

    Ok(raw_entries
        .into_iter()
        .enumerate()
        .map(|(idx, (x, y, z, key))| MatrixCell {
            cell_index: idx as u16,
            pixel_key: key,
            grid_xyz: [x, y, z],
            local_uv: [axis_uv(x, max_x), axis_uv(y, max_y)],
        })
        .collect())
}

pub fn expand_canonical_matrix_cells(matrix: &OflMatrix) -> Result<Vec<MatrixCell>, OflError> {
    if let Some(pixel_keys) = &matrix.pixel_keys {
        return expand_from_pixel_keys(pixel_keys);
    }

    let [nx, ny, nz] = matrix.pixel_count.ok_or(OflError::MissingMatrix)?;
    if nx == 0 || ny == 0 || nz == 0 {
        return Err(OflError::MissingMatrix);
    }

    let mut cells = Vec::with_capacity((nx as usize) * (ny as usize) * (nz as usize));
    let mut cell_index: u16 = 0;
    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                cells.push(MatrixCell {
                    cell_index,
                    pixel_key: format_pixel_key(x, y, z, nx, ny, nz),
                    grid_xyz: [x, y, z],
                    local_uv: [axis_uv(x, nx), axis_uv(y, ny)],
                });
                cell_index += 1;
            }
        }
    }

    Ok(cells)
}

pub fn order_matrix_cells_for_repeat(
    matrix: &OflMatrix,
    repeat_for: &OflRepeatFor,
) -> Result<Vec<MatrixCell>, OflError> {
    let canonical = expand_canonical_matrix_cells(matrix)?;

    match repeat_for {
        OflRepeatFor::ExplicitKeys(keys) => {
            let lookup: HashMap<&str, &MatrixCell> = canonical
                .iter()
                .map(|c| (c.pixel_key.as_str(), c))
                .collect();
            let mut out = Vec::with_capacity(keys.len());
            for key in keys {
                if let Some(cell) = lookup.get(key.as_str()) {
                    out.push((*cell).clone());
                } else if let Some(group_def) = matrix.pixel_groups.get(key.as_str()) {
                    let members: Vec<&MatrixCell> = if group_def.as_str() == Some("all") {
                        canonical.iter().collect()
                    } else if let Some(arr) = group_def.as_array() {
                        arr.iter()
                            .filter_map(|v| v.as_str())
                            .filter_map(|k| lookup.get(k).copied())
                            .collect()
                    } else {
                        Vec::new()
                    };
                    if !members.is_empty() {
                        let n = members.len() as f32;
                        let avg_u = members.iter().map(|c| c.local_uv[0]).sum::<f32>() / n;
                        let avg_v = members.iter().map(|c| c.local_uv[1]).sum::<f32>() / n;
                        let seg_idx = out.len() as u16;
                        out.push(MatrixCell {
                            cell_index: seg_idx,
                            pixel_key: key.clone(),
                            grid_xyz: [seg_idx, 0, 0],
                            local_uv: [avg_u, avg_v],
                        });
                    }
                }
            }
            Ok(out)
        }
        OflRepeatFor::Order(order) => {
            let mut cells = canonical;
            match order.as_str() {
                "eachPixelABC" | "eachPixelXYZ" => {}
                "eachPixelXZY" => cells.sort_by_key(|c| (c.grid_xyz[1], c.grid_xyz[2], c.grid_xyz[0])),
                "eachPixelYXZ" => cells.sort_by_key(|c| (c.grid_xyz[2], c.grid_xyz[0], c.grid_xyz[1])),
                "eachPixelYZX" => cells.sort_by_key(|c| (c.grid_xyz[0], c.grid_xyz[2], c.grid_xyz[1])),
                "eachPixelZXY" => cells.sort_by_key(|c| (c.grid_xyz[1], c.grid_xyz[0], c.grid_xyz[2])),
                "eachPixelZYX" => cells.sort_by_key(|c| (c.grid_xyz[0], c.grid_xyz[1], c.grid_xyz[2])),
                "eachPixelGroup" => {
                    // Preserve canonical cells if group keys are requested generically
                }
                group_name => {
                    if let Some(group_def) = matrix.pixel_groups.get(group_name) {
                        if group_def.as_str() == Some("all") {
                            return Ok(cells);
                        }
                        if let Some(arr) = group_def.as_array() {
                            let wanted: Vec<&str> =
                                arr.iter().filter_map(|v| v.as_str()).collect();
                            cells.retain(|c| wanted.contains(&c.pixel_key.as_str()));
                            return Ok(cells);
                        }
                    }
                    return Err(OflError::PixelGroupNotFound(group_name.to_string()));
                }
            }
            Ok(cells)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn expands_1d_8px_matrix_with_1_based_keys_and_0_based_cells() {
        let matrix = OflMatrix {
            pixel_count: Some([8, 1, 1]),
            pixel_keys: None,
            pixel_groups: BTreeMap::new(),
        };

        let cells = expand_canonical_matrix_cells(&matrix).unwrap();
        assert_eq!(cells.len(), 8);
        assert_eq!(cells[0].cell_index, 0);
        assert_eq!(cells[0].pixel_key, "1");
        assert!((cells[0].local_uv[0] - (-0.5)).abs() < 1e-5);
        assert!((cells[0].local_uv[1] - 0.0).abs() < 1e-5);

        assert_eq!(cells[7].cell_index, 7);
        assert_eq!(cells[7].pixel_key, "8");
        assert!((cells[7].local_uv[0] - 0.5).abs() < 1e-5);
    }

    #[test]
    fn supports_2d_matrix_axes_and_explicit_pixel_keys() {
        let matrix = OflMatrix {
            pixel_count: Some([2, 2, 1]),
            pixel_keys: None,
            pixel_groups: BTreeMap::new(),
        };

        let abc =
            order_matrix_cells_for_repeat(&matrix, &OflRepeatFor::Order("eachPixelABC".into()))
                .unwrap();
        let keys_abc: Vec<&str> = abc.iter().map(|c| c.pixel_key.as_str()).collect();
        assert_eq!(keys_abc, vec!["1-1", "2-1", "1-2", "2-2"]);

        let yxz =
            order_matrix_cells_for_repeat(&matrix, &OflRepeatFor::Order("eachPixelYXZ".into()))
                .unwrap();
        let keys_yxz: Vec<&str> = yxz.iter().map(|c| c.pixel_key.as_str()).collect();
        assert_eq!(keys_yxz, vec!["1-1", "1-2", "2-1", "2-2"]);
        assert_eq!(yxz[1].cell_index, 2);

        let explicit = OflMatrix {
            pixel_count: None,
            pixel_keys: Some(serde_json::json!(["Left", "Center", "Right"])),
            pixel_groups: BTreeMap::new(),
        };
        let exp_cells = expand_canonical_matrix_cells(&explicit).unwrap();
        assert_eq!(exp_cells.len(), 3);
        assert_eq!(exp_cells[0].pixel_key, "Left");
        assert_eq!(exp_cells[1].pixel_key, "Center");
        assert_eq!(exp_cells[2].pixel_key, "Right");
        assert!((exp_cells[1].local_uv[0] - 0.0).abs() < 1e-5);
    }

    #[test]
    fn expands_2d_3d_pixel_keys_single_axis_counts_and_rejects_empty_matrices() {
        // 2D pixelKeys
        let m2d = OflMatrix {
            pixel_count: None,
            pixel_keys: Some(serde_json::json!([["A1", "A2"], ["B1", "B2"]])),
            pixel_groups: BTreeMap::new(),
        };
        let c2d = expand_canonical_matrix_cells(&m2d).unwrap();
        assert_eq!(c2d.len(), 4);
        assert_eq!(c2d[3].pixel_key, "B2");
        assert_eq!(c2d[3].grid_xyz, [1, 1, 0]);

        // 3D pixelKeys
        let m3d = OflMatrix {
            pixel_count: None,
            pixel_keys: Some(serde_json::json!([[["Z0"]], [["Z1"]]])),
            pixel_groups: BTreeMap::new(),
        };
        let c3d = expand_canonical_matrix_cells(&m3d).unwrap();
        assert_eq!(c3d.len(), 2);
        assert_eq!(c3d[1].grid_xyz, [0, 0, 1]);

        // Single-axis Y and Z and 1x1x1 and 2x2x2 pixel_count formatting
        for (dims, expected_last) in [
            ([1, 1, 1], "1"),
            ([1, 3, 1], "3"),
            ([1, 1, 2], "2"),
            ([2, 2, 2], "2-2-2"),
        ] {
            let m = OflMatrix {
                pixel_count: Some(dims),
                pixel_keys: None,
                pixel_groups: BTreeMap::new(),
            };
            let cells = expand_canonical_matrix_cells(&m).unwrap();
            assert_eq!(cells.last().unwrap().pixel_key, expected_last);
        }

        // Invalid / empty matrices
        let empty = OflMatrix {
            pixel_count: None,
            pixel_keys: None,
            pixel_groups: BTreeMap::new(),
        };
        assert!(expand_canonical_matrix_cells(&empty).is_err());

        let zero_dim = OflMatrix {
            pixel_count: Some([0, 1, 1]),
            pixel_keys: None,
            pixel_groups: BTreeMap::new(),
        };
        assert!(expand_canonical_matrix_cells(&zero_dim).is_err());

        let empty_arr = OflMatrix {
            pixel_count: None,
            pixel_keys: Some(serde_json::json!([])),
            pixel_groups: BTreeMap::new(),
        };
        assert!(expand_canonical_matrix_cells(&empty_arr).is_err());

        let null_entries = OflMatrix {
            pixel_count: None,
            pixel_keys: Some(serde_json::json!([null, null])),
            pixel_groups: BTreeMap::new(),
        };
        assert!(expand_canonical_matrix_cells(&null_entries).is_err());
    }

    #[test]
    fn orders_all_repeat_for_axes_and_resolves_pixel_groups() {
        let mut groups = BTreeMap::new();
        groups.insert("all_px".to_string(), serde_json::json!("all"));
        groups.insert("front".to_string(), serde_json::json!(["1-1-1", "2-1-1"]));
        groups.insert("empty_grp".to_string(), serde_json::json!({}));

        let matrix = OflMatrix {
            pixel_count: Some([2, 2, 2]),
            pixel_keys: None,
            pixel_groups: groups,
        };

        for order in [
            "eachPixelXYZ",
            "eachPixelXZY",
            "eachPixelYXZ",
            "eachPixelYZX",
            "eachPixelZXY",
            "eachPixelZYX",
            "eachPixelGroup",
        ] {
            let ordered =
                order_matrix_cells_for_repeat(&matrix, &OflRepeatFor::Order(order.into())).unwrap();
            assert_eq!(ordered.len(), 8);
        }

        // Named pixel group ("all" and explicit array)
        let all_res =
            order_matrix_cells_for_repeat(&matrix, &OflRepeatFor::Order("all_px".into())).unwrap();
        assert_eq!(all_res.len(), 8);

        let front_res =
            order_matrix_cells_for_repeat(&matrix, &OflRepeatFor::Order("front".into())).unwrap();
        assert_eq!(front_res.len(), 2);

        // Missing pixel group errors
        assert!(
            order_matrix_cells_for_repeat(&matrix, &OflRepeatFor::Order("nonexistent".into()))
                .is_err()
        );

        // ExplicitKeys mixing direct key + pixel group ("all", array, and ignored invalid group)
        let explicit = order_matrix_cells_for_repeat(
            &matrix,
            &OflRepeatFor::ExplicitKeys(vec![
                "1-1-1".into(),
                "front".into(),
                "all_px".into(),
                "empty_grp".into(),
            ]),
        )
        .unwrap();
        assert_eq!(explicit.len(), 3);
        assert_eq!(explicit[1].pixel_key, "front");
        assert_eq!(explicit[2].pixel_key, "all_px");
    }
}
