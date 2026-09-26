//! Build script: generates placeholder icons when the real ones are absent, then
//! runs tauri-build with an explicit app command manifest so that *only* commands
//! granted in `capabilities/` are callable from the webview.

use std::{fs, path::Path};

/// App commands exposed to the frontend. Listing them here makes tauri-build
/// generate `allow-<name>` / `deny-<name>` permissions and enforces ACL checks
/// on them (without this, app commands are allowed by default).
const APP_COMMANDS: &[&str] = &[
    "get_launch_args",
    "pick_recording",
    "list_recording_entries",
    "read_recording_entry",
    "list_recent_recordings",
    "open_recent_recording",
    "clear_recent_recordings",
    "save_export",
];

fn main() {
    ensure_placeholder_icons();
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to run tauri-build");
}

// ---------------------------------------------------------------------------
// Placeholder icons
//
// Release artwork is `icons/app-icon.svg`; produce the icon set with
// `npm run tauri icon src-tauri/icons/app-icon.svg` and commit it (binary files
// can't be pushed through the GitHub API tooling used on this branch, see
// docs/integration/desktop.md). Until then we rasterise the same dome mark
// here so `cargo check` / `cargo build` / `tauri build` work from a fresh
// checkout without binary files in Git. Existing files are never overwritten.
// ---------------------------------------------------------------------------

fn ensure_placeholder_icons() {
    let dir = Path::new("icons");
    println!("cargo:rerun-if-changed=icons");
    let _ = fs::create_dir_all(dir);
    for (name, size) in [("32x32.png", 32u32), ("128x128.png", 128), ("icon.png", 512)] {
        let path = dir.join(name);
        if !path.exists() {
            fs::write(&path, png_rgba(size, &icon_pixels(size))).expect("write placeholder png");
        }
    }
    let ico = dir.join("icon.ico");
    if !ico.exists() {
        fs::write(&ico, ico_from_png(64, &png_rgba(64, &icon_pixels(64)))).expect("write placeholder ico");
    }
}

type Rgb = [f32; 3];

fn hex(c: u32) -> Rgb {
    [((c >> 16) & 0xff) as f32, ((c >> 8) & 0xff) as f32, (c & 0xff) as f32]
}

fn lerp(a: Rgb, b: Rgb, t: f32) -> Rgb {
    let t = t.clamp(0.0, 1.0);
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

fn in_round_rect(x: f32, y: f32, x0: f32, y0: f32, x1: f32, y1: f32, r: f32) -> bool {
    if x < x0 || x > x1 || y < y0 || y > y1 {
        return false;
    }
    let cx = x.clamp(x0 + r, x1 - r);
    let cy = y.clamp(y0 + r, y1 - r);
    (x - cx).powi(2) + (y - cy).powi(2) <= r * r
}

fn in_polygon(x: f32, y: f32, pts: &[(f32, f32)]) -> bool {
    let mut inside = false;
    let mut j = pts.len() - 1;
    for i in 0..pts.len() {
        let ((xi, yi), (xj, yj)) = (pts[i], pts[j]);
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn near_segment(x: f32, y: f32, (ax, ay): (f32, f32), (bx, by): (f32, f32), half_width: f32) -> bool {
    let (dx, dy) = (bx - ax, by - ay);
    let t = (((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
    (x - ax - t * dx).powi(2) + (y - ay - t * dy).powi(2) <= half_width * half_width
}

/// Colour of the dome mark at (x, y) in the SVG's 1024x1024 space, or None if
/// transparent. Mirrors `icons/app-icon.svg` shape for shape.
fn sample(x: f32, y: f32) -> Option<Rgb> {
    if !in_round_rect(x, y, 24.0, 24.0, 1000.0, 1000.0, 216.0) {
        return None;
    }
    let mut c = if in_round_rect(x, y, 40.0, 40.0, 984.0, 984.0, 200.0) {
        lerp(hex(0x162238), hex(0x070b14), (y - 32.0) / 960.0)
    } else {
        hex(0x24334a)
    };
    let star = [
        (760.0, 190.0), (784.0, 250.0), (844.0, 274.0), (784.0, 298.0),
        (760.0, 358.0), (736.0, 298.0), (676.0, 274.0), (736.0, 250.0),
    ];
    if in_polygon(x, y, &star) {
        c = hex(0xe8f1ff);
    }
    if (x - 300.0).powi(2) + (y - 230.0).powi(2) <= 14.0 * 14.0 {
        c = hex(0xa855f7);
    }
    if (x - 860.0).powi(2) + (y - 430.0).powi(2) <= 10.0 * 10.0 {
        c = hex(0x22d3ee);
    }
    if near_segment(x, y, (520.0, 560.0), (700.0, 338.0), 15.0) {
        c = hex(0xe8f1ff);
    }
    if y <= 640.0 && (x - 512.0).powi(2) + (y - 640.0).powi(2) <= 280.0 * 280.0 {
        c = lerp(hex(0x22d3ee), hex(0x3b82f6), ((x - 232.0) + (y - 360.0)) / 840.0);
    }
    // Open shutter: the rect (470..566, 364..640) rotated 38 degrees about (518, 640).
    let (s, co) = (-38f32).to_radians().sin_cos();
    let (rx, ry) = (x - 518.0, y - 640.0);
    let (ux, uy) = (518.0 + rx * co - ry * s, 640.0 + rx * s + ry * co);
    if (470.0..=566.0).contains(&ux) && (364.0..=640.0).contains(&uy) {
        c = hex(0x070b14);
    }
    if in_round_rect(x, y, 244.0, 632.0, 780.0, 838.0, 26.0) {
        c = if in_round_rect(x, y, 260.0, 648.0, 764.0, 822.0, 10.0) { hex(0x0f1726) } else { hex(0x22d3ee) };
    }
    if in_round_rect(x, y, 468.0, 712.0, 556.0, 830.0, 10.0) {
        c = hex(0x22d3ee);
    }
    if in_round_rect(x, y, 200.0, 824.0, 824.0, 852.0, 14.0) {
        c = hex(0x24334a);
    }
    Some(c)
}

/// Rasterise the dome mark at `size` px with 4x4 supersampling.
fn icon_pixels(size: u32) -> Vec<u8> {
    const SS: u32 = 4;
    let scale = 1024.0 / (size * SS) as f32;
    let mut px = Vec::with_capacity((size * size * 4) as usize);
    for y in 0..size {
        for x in 0..size {
            let (mut acc, mut hits) = ([0f32; 3], 0u32);
            for sy in 0..SS {
                for sx in 0..SS {
                    let fx = ((x * SS + sx) as f32 + 0.5) * scale;
                    let fy = ((y * SS + sy) as f32 + 0.5) * scale;
                    if let Some(c) = sample(fx, fy) {
                        for k in 0..3 {
                            acc[k] += c[k];
                        }
                        hits += 1;
                    }
                }
            }
            let n = hits.max(1) as f32;
            let a = (hits * 255 / (SS * SS)) as u8;
            px.extend_from_slice(&[(acc[0] / n) as u8, (acc[1] / n) as u8, (acc[2] / n) as u8, a]);
        }
    }
    px
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &d in data {
        a = (a + d as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

/// Minimal PNG encoder (8-bit RGBA, zlib "stored" blocks, no compression).
fn png_rgba(size: u32, rgba: &[u8]) -> Vec<u8> {
    let mut raw = Vec::with_capacity(rgba.len() + size as usize);
    for row in rgba.chunks(size as usize * 4) {
        raw.push(0); // filter: none
        raw.extend_from_slice(row);
    }
    let mut z = vec![0x78, 0x01];
    let mut chunks = raw.chunks(65535).peekable();
    while let Some(block) = chunks.next() {
        z.push(if chunks.peek().is_none() { 1 } else { 0 });
        let len = block.len() as u16;
        z.extend_from_slice(&len.to_le_bytes());
        z.extend_from_slice(&(!len).to_le_bytes());
        z.extend_from_slice(block);
    }
    z.extend_from_slice(&adler32(&raw).to_be_bytes());

    let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&size.to_be_bytes());
    ihdr.extend_from_slice(&size.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    for (kind, data) in [(b"IHDR", ihdr), (b"IDAT", z), (b"IEND", Vec::new())] {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut body = kind.to_vec();
        body.extend_from_slice(&data);
        out.extend_from_slice(&body);
        out.extend_from_slice(&crc32(&body).to_be_bytes());
    }
    out
}

/// Single-image ICO wrapping a PNG payload (supported since Windows Vista).
fn ico_from_png(size: u32, png: &[u8]) -> Vec<u8> {
    let mut out = vec![0, 0, 1, 0, 1, 0];
    let dim = if size >= 256 { 0 } else { size as u8 };
    out.extend_from_slice(&[dim, dim, 0, 0, 1, 0, 32, 0]);
    out.extend_from_slice(&(png.len() as u32).to_le_bytes());
    out.extend_from_slice(&22u32.to_le_bytes());
    out.extend_from_slice(png);
    out
}
