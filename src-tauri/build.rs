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
// Real artwork should be produced with `npm run tauri icon <source.png>` and
// committed. Until then we synthesise simple RGBA icons so `cargo check` /
// `cargo build` / `tauri build` work from a fresh checkout without binary
// files in Git. Existing files are never overwritten.
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

/// Dark rounded square with a teal ring ("observatory lens").
fn icon_pixels(size: u32) -> Vec<u8> {
    let s = size as f32;
    let c = (s - 1.0) / 2.0;
    let mut px = Vec::with_capacity((size * size * 4) as usize);
    for y in 0..size {
        for x in 0..size {
            let (dx, dy) = (x as f32 - c, y as f32 - c);
            let r = (dx * dx + dy * dy).sqrt() / (s / 2.0);
            let corner = (dx.abs().max(dy.abs())) / (s / 2.0);
            let (mut rgb, mut a) = ([0x0b, 0x10, 0x1a], 255u8);
            if corner > 0.98 {
                a = 0;
            }
            if (0.55..0.72).contains(&r) {
                rgb = [0x3d, 0xd6, 0xc6];
            } else if r < 0.2 {
                rgb = [0xe8, 0xf1, 0xff];
            }
            px.extend_from_slice(&[rgb[0], rgb[1], rgb[2], a]);
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
