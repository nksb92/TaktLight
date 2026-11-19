use serde::{Deserialize, Serialize};

use crate::show::xml::{ColorPaletteDef, DimmerPaletteDef};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompiledColorPalette {
    pub id: String,
    pub name: String,
    pub hex_start: String,
    pub hex_end: String,
    #[serde(default)]
    pub colors: Vec<String>,
    pub linear_start: [f32; 3],
    pub linear_end: [f32; 3],
    pub oklab_start: [f32; 3],
    pub oklab_end: [f32; 3],
    #[serde(default)]
    pub oklab_stops: Vec<[f32; 3]>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompiledDimmerPalette {
    pub id: String,
    pub name: String,
    pub value_start: f32,
    pub value_end: f32,
}

pub fn parse_hex_srgb(hex: &str) -> Option<[u8; 3]> {
    let trimmed = hex.trim().strip_prefix('#').unwrap_or_else(|| hex.trim());
    if trimmed.len() == 6 {
        let r = u8::from_str_radix(&trimmed[0..2], 16).ok()?;
        let g = u8::from_str_radix(&trimmed[2..4], 16).ok()?;
        let b = u8::from_str_radix(&trimmed[4..6], 16).ok()?;
        return Some([r, g, b]);
    }
    if trimmed.len() == 3 {
        let r = u8::from_str_radix(&trimmed[0..1], 16).ok()?;
        let g = u8::from_str_radix(&trimmed[1..2], 16).ok()?;
        let b = u8::from_str_radix(&trimmed[2..3], 16).ok()?;
        return Some([r * 17, g * 17, b * 17]);
    }
    None
}

#[inline]
pub fn srgb_channel_to_linear(c: f32) -> f32 {
    let c = c.clamp(0.0, 1.0);
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

#[inline]
pub fn linear_channel_to_srgb(c: f32) -> f32 {
    if c <= 0.0 {
        return 0.0;
    }
    if c >= 1.0 {
        return 1.0;
    }
    if c <= 0.003_130_8 {
        12.92 * c
    } else {
        (1.055 * c.powf(1.0 / 2.4) - 0.055).clamp(0.0, 1.0)
    }
}

pub fn srgb_to_linear_rgb(rgb: [u8; 3]) -> [f32; 3] {
    [
        srgb_channel_to_linear(rgb[0] as f32 / 255.0),
        srgb_channel_to_linear(rgb[1] as f32 / 255.0),
        srgb_channel_to_linear(rgb[2] as f32 / 255.0),
    ]
}

pub fn linear_rgb_to_srgb_u8(rgb: [f32; 3]) -> [u8; 3] {
    [
        (linear_channel_to_srgb(rgb[0]) * 255.0).round().clamp(0.0, 255.0) as u8,
        (linear_channel_to_srgb(rgb[1]) * 255.0).round().clamp(0.0, 255.0) as u8,
        (linear_channel_to_srgb(rgb[2]) * 255.0).round().clamp(0.0, 255.0) as u8,
    ]
}

pub fn linear_rgb_to_oklab(rgb: [f32; 3]) -> [f32; 3] {
    let r = rgb[0].max(0.0);
    let g = rgb[1].max(0.0);
    let b = rgb[2].max(0.0);

    let l = 0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b;
    let m = 0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b;
    let s = 0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b;

    let l_ = l.max(0.0).cbrt();
    let m_ = m.max(0.0).cbrt();
    let s_ = s.max(0.0).cbrt();

    [
        0.210_454_26 * l_ + 0.793_617_8 * m_ - 0.004_072_047 * s_,
        1.977_998_5 * l_ - 2.428_592_2 * m_ + 0.450_593_7 * s_,
        0.025_904_037 * l_ + 0.782_771_77 * m_ - 0.808_675_77 * s_,
    ]
}

pub fn oklab_to_linear_rgb(lab: [f32; 3]) -> [f32; 3] {
    let l_ = lab[0] + 0.396_337_78 * lab[1] + 0.215_803_76 * lab[2];
    let m_ = lab[0] - 0.105_561_346 * lab[1] - 0.063_854_17 * lab[2];
    let s_ = lab[0] - 0.089_484_18 * lab[1] - 1.291_485_5 * lab[2];

    let l = l_ * l_ * l_;
    let m = m_ * m_ * m_;
    let s = s_ * s_ * s_;

    [
        (4.076_741_7 * l - 3.307_711_6 * m + 0.230_969_94 * s).clamp(0.0, 1.0),
        (-1.268_438 * l + 2.609_757_4 * m - 0.341_319_4 * s).clamp(0.0, 1.0),
        (-0.004_196_086 * l - 0.703_418_6 * m + 1.707_614_7 * s).clamp(0.0, 1.0),
    ]
}

pub fn oklab_distance(a: [f32; 3], b: [f32; 3]) -> f32 {
    let dl = a[0] - b[0];
    let da = a[1] - b[1];
    let db = a[2] - b[2];
    (dl * dl + da * da + db * db).sqrt()
}

pub fn parse_hex_to_linear_rgb(hex: &str) -> Option<[f32; 3]> {
    parse_hex_srgb(hex).map(srgb_to_linear_rgb)
}

pub fn parse_hex_to_oklab(hex: &str) -> Option<[f32; 3]> {
    parse_hex_to_linear_rgb(hex).map(linear_rgb_to_oklab)
}

pub fn resolve_named_css_color_to_oklab(name: &str) -> Option<[f32; 3]> {
    let normalized: String = name
        .chars()
        .filter(|c| !matches!(c, ' ' | '_' | '-'))
        .map(|c| c.to_ascii_lowercase())
        .collect();

    let srgb = match normalized.as_str() {
        "red" => [255, 0, 0],
        "green" => [0, 255, 0],
        "blue" => [0, 0, 255],
        "white" | "openwhite" => [255, 255, 255],
        "warmwhite" => [255, 224, 178],
        "coldwhite" | "coolwhite" => [216, 236, 255],
        "amber" => [255, 191, 0],
        "orange" => [255, 128, 0],
        "yellow" => [255, 255, 0],
        "cyan" | "aqua" => [0, 255, 255],
        "magenta" | "fuchsia" => [255, 0, 255],
        "purple" | "violet" => [148, 0, 211],
        "uv" | "ultraviolet" => [75, 0, 130],
        "pink" => [255, 105, 180],
        "lime" => [50, 205, 50],
        "lavender" => [180, 160, 255],
        "congoblue" => [18, 10, 143],
        "cto" => [255, 204, 136],
        "ctb" => [170, 212, 255],
        "black" | "closed" => [0, 0, 0],
        _ => return None,
    };

    Some(linear_rgb_to_oklab(srgb_to_linear_rgb(srgb)))
}

pub fn sample_oklab_stops_linear(
    stops: &[[f32; 3]],
    w: f32,
    gradient: f32,
    grayscale: bool,
    cyclic: bool,
) -> [f32; 3] {
    let mut rgb = if stops.is_empty() {
        [0.0, 0.0, 0.0]
    } else if stops.len() == 1 {
        oklab_to_linear_rgb(stops[0])
    } else {
        let g = gradient.clamp(0.0, 1.0);
        let (idx, next, frac) = if cyclic {
            let n = stops.len();
            let t = w.rem_euclid(1.0);
            let pos = t * (n as f32);
            let i = (pos.floor() as usize) % n;
            let nxt = (i + 1) % n;
            let f = (pos - pos.floor()).clamp(0.0, 1.0);
            (i, nxt, f)
        } else {
            let n = stops.len();
            let t = w.clamp(0.0, 1.0);
            let pos = t * ((n - 1) as f32);
            let i = (pos.floor() as usize).min(n - 2);
            let nxt = i + 1;
            let f = (pos - (i as f32)).clamp(0.0, 1.0);
            (i, nxt, f)
        };

        let eff_frac = if g <= 1e-4 {
            0.0
        } else if g >= 0.9999 {
            frac
        } else {
            ((frac - (1.0 - g)) / g).clamp(0.0, 1.0)
        };

        let a = stops[idx];
        let b = stops[next];
        let lab = [
            a[0] + eff_frac * (b[0] - a[0]),
            a[1] + eff_frac * (b[1] - a[1]),
            a[2] + eff_frac * (b[2] - a[2]),
        ];
        oklab_to_linear_rgb(lab)
    };

    if grayscale {
        let y = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]).clamp(0.0, 1.0);
        rgb = [y, y, y];
    }
    rgb
}

pub fn sample_hex_stops_linear(
    hex_stops: &[String],
    w: f32,
    gradient: f32,
    grayscale: bool,
    cyclic: bool,
) -> [f32; 3] {
    let oklab_stops: Vec<[f32; 3]> = hex_stops
        .iter()
        .filter_map(|h| parse_hex_to_oklab(h))
        .collect();
    sample_oklab_stops_linear(&oklab_stops, w, gradient, grayscale, cyclic)
}

pub fn sample_value_stops(stops: &[f32], w: f32, gradient: f32, cyclic: bool) -> f32 {
    if stops.is_empty() {
        return 0.0;
    }
    if stops.len() == 1 {
        return stops[0].clamp(0.0, 1.0);
    }
    let g = gradient.clamp(0.0, 1.0);
    let (idx, next, frac) = if cyclic {
        let n = stops.len();
        let t = w.rem_euclid(1.0);
        let pos = t * (n as f32);
        let i = (pos.floor() as usize) % n;
        let nxt = (i + 1) % n;
        let f = (pos - pos.floor()).clamp(0.0, 1.0);
        (i, nxt, f)
    } else {
        let n = stops.len();
        let t = w.clamp(0.0, 1.0);
        let pos = t * ((n - 1) as f32);
        let i = (pos.floor() as usize).min(n - 2);
        let nxt = i + 1;
        let f = (pos - (i as f32)).clamp(0.0, 1.0);
        (i, nxt, f)
    };

    let eff_frac = if g <= 1e-4 {
        0.0
    } else if g >= 0.9999 {
        frac
    } else {
        ((frac - (1.0 - g)) / g).clamp(0.0, 1.0)
    };

    let a = stops[idx].clamp(0.0, 1.0);
    let b = stops[next].clamp(0.0, 1.0);
    (a + eff_frac * (b - a)).clamp(0.0, 1.0)
}

impl CompiledColorPalette {
    pub fn from_def(def: &ColorPaletteDef) -> Self {
        let raw_colors = def.effective_colors();
        let hex_start = raw_colors
            .first()
            .cloned()
            .unwrap_or_else(|| def.hex_start.clone());
        let hex_end = raw_colors
            .last()
            .cloned()
            .unwrap_or_else(|| def.hex_end.clone());
        let linear_start = parse_hex_to_linear_rgb(&hex_start).unwrap_or([0.0, 0.0, 0.0]);
        let linear_end = parse_hex_to_linear_rgb(&hex_end).unwrap_or([1.0, 1.0, 1.0]);
        let oklab_start = linear_rgb_to_oklab(linear_start);
        let oklab_end = linear_rgb_to_oklab(linear_end);
        let mut oklab_stops: Vec<[f32; 3]> = raw_colors
            .iter()
            .filter_map(|h| parse_hex_to_oklab(h))
            .collect();
        if oklab_stops.is_empty() {
            oklab_stops = vec![oklab_start, oklab_end];
        }
        Self {
            id: def.id.clone(),
            name: def.name.clone(),
            hex_start,
            hex_end,
            colors: raw_colors,
            linear_start,
            linear_end,
            oklab_start,
            oklab_end,
            oklab_stops,
        }
    }

    pub fn sample_linear_rgb(&self, w: f32) -> [f32; 3] {
        sample_oklab_stops_linear(&self.oklab_stops, w, 1.0, false, false)
    }

    pub fn sample_linear_rgb_ex(
        &self,
        w: f32,
        gradient: f32,
        grayscale: bool,
        cyclic: bool,
    ) -> [f32; 3] {
        sample_oklab_stops_linear(&self.oklab_stops, w, gradient, grayscale, cyclic)
    }
}

impl CompiledDimmerPalette {
    pub fn from_def(def: &DimmerPaletteDef) -> Self {
        Self {
            id: def.id.clone(),
            name: def.name.clone(),
            value_start: def.value_start.clamp(0.0, 1.0),
            value_end: def.value_end.clamp(0.0, 1.0),
        }
    }

    pub fn sample_dimmer(&self, u: f32) -> f32 {
        let t = u.clamp(0.0, 1.0);
        (self.value_start + t * (self.value_end - self.value_start)).clamp(0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srgb_to_linear_and_oklab_round_trips_accurately() {
        let samples = [
            [255, 85, 0],
            [34, 85, 170],
            [255, 255, 255],
            [0, 0, 0],
            [128, 64, 220],
        ];
        for rgb in samples {
            let lin = srgb_to_linear_rgb(rgb);
            let lab = linear_rgb_to_oklab(lin);
            let back_lin = oklab_to_linear_rgb(lab);
            let back_u8 = linear_rgb_to_srgb_u8(back_lin);
            for c in 0..3 {
                assert!(
                    (rgb[c] as i16 - back_u8[c] as i16).abs() <= 1,
                    "round-trip mismatch for {rgb:?}: got {back_u8:?}"
                );
            }
        }
    }

    #[test]
    fn color_palette_interpolates_linearly_in_oklab_space() {
        let def = ColorPaletteDef {
            id: "pal_cyber".into(),
            name: "Cyberpunk Dual".into(),
            hex_start: "#FF5500".into(),
            hex_end: "#2255AA".into(),
            colors: Vec::new(),
        };
        let compiled = CompiledColorPalette::from_def(&def);
        let mid_linear = compiled.sample_linear_rgb(0.5);
        let expected_mid_lab = [
            0.5 * (compiled.oklab_start[0] + compiled.oklab_end[0]),
            0.5 * (compiled.oklab_start[1] + compiled.oklab_end[1]),
            0.5 * (compiled.oklab_start[2] + compiled.oklab_end[2]),
        ];
        let expected_mid_linear = oklab_to_linear_rgb(expected_mid_lab);
        for c in 0..3 {
            assert!((mid_linear[c] - expected_mid_linear[c]).abs() < 1e-6);
        }

        // Red (#FF0000) to Green (#00FF00): OKLAB yields bright high-chroma yellow vs naive sRGB #808000 olive
        let rg = CompiledColorPalette::from_def(&ColorPaletteDef {
            id: "pal_rg".into(),
            name: "Red Green".into(),
            hex_start: "#FF0000".into(),
            hex_end: "#00FF00".into(),
            colors: Vec::new(),
        });
        let rg_mid_lab = linear_rgb_to_oklab(rg.sample_linear_rgb(0.5));
        let naive_olive_lab = linear_rgb_to_oklab(srgb_to_linear_rgb([128, 128, 0]));
        let rg_chroma = (rg_mid_lab[1] * rg_mid_lab[1] + rg_mid_lab[2] * rg_mid_lab[2]).sqrt();
        let olive_chroma =
            (naive_olive_lab[1] * naive_olive_lab[1] + naive_olive_lab[2] * naive_olive_lab[2])
                .sqrt();
        assert!(rg_mid_lab[0] > naive_olive_lab[0] + 0.15);
        assert!(rg_chroma > olive_chroma);
    }

    #[test]
    fn named_css_color_table_resolves_standard_colors_and_rejects_unknown() {
        let red = resolve_named_css_color_to_oklab("Red").expect("Red should resolve");
        let pure_red = linear_rgb_to_oklab([1.0, 0.0, 0.0]);
        assert!(oklab_distance(red, pure_red) < 0.01);

        assert!(resolve_named_css_color_to_oklab("Warm White").is_some());
        assert!(resolve_named_css_color_to_oklab("Amber").is_some());
        assert!(resolve_named_css_color_to_oklab("Congo Blue").is_some());
        assert!(resolve_named_css_color_to_oklab("Gobo Starburst 7").is_none());
    }

    #[test]
    fn multistop_cyclic_gradient_and_grayscale_work_accurately() {
        let rainbow = CompiledColorPalette::from_def(&ColorPaletteDef {
            id: "pal_rainbow".into(),
            name: "Rainbow".into(),
            hex_start: "#FF0000".into(),
            hex_end: "#0000FF".into(),
            colors: vec!["#FF0000".into(), "#00FF00".into(), "#0000FF".into()],
        });
        let at_0 = rainbow.sample_linear_rgb_ex(0.0, 1.0, false, true);
        assert!(at_0[0] > 0.99 && at_0[1] < 0.01 && at_0[2] < 0.01);
        let at_third = rainbow.sample_linear_rgb_ex(1.0 / 3.0 + 1e-4, 1.0, false, true);
        assert!(at_third[1] > 0.98);
        let at_two_thirds = rainbow.sample_linear_rgb_ex(2.0 / 3.0 + 1e-4, 1.0, false, true);
        assert!(at_two_thirds[2] > 0.98);

        // Stepped gradient (0.0) holds stop[0] across first segment
        let stepped = rainbow.sample_linear_rgb_ex(0.25, 0.0, false, true);
        assert!(stepped[0] > 0.99 && stepped[1] < 0.01 && stepped[2] < 0.01);

        // Grayscale forces equal RGB channels
        let gray = rainbow.sample_linear_rgb_ex(0.0, 1.0, true, true);
        assert!((gray[0] - gray[1]).abs() < 1e-6 && (gray[1] - gray[2]).abs() < 1e-6);
        assert!(gray[0] > 0.1 && gray[0] < 0.3);
    }
}
