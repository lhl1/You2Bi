//! Windows credentials are encrypted before any temporary file is written.
//! Legacy plaintext is readable for import; the next save writes DPAPI only.
use std::{io, path::Path};
const MAGIC: &[u8] = b"STREAMARCHIVE-DPAPI-1\n";

pub fn read(path: &Path) -> io::Result<Vec<u8>> {
    let bytes = std::fs::read(path)?;
    decode(&bytes)
}

pub fn decode(bytes: &[u8]) -> io::Result<Vec<u8>> {
    if let Some(payload) = bytes.strip_prefix(MAGIC) {
        crypt(payload, false)
    } else {
        Ok(bytes.to_vec())
    }
}

pub fn encode(bytes: &[u8]) -> io::Result<Vec<u8>> {
    #[cfg(windows)]
    {
        let payload = crypt(bytes, true)?;
        let mut output = MAGIC.to_vec();
        output.extend(payload);
        Ok(output)
    }
    #[cfg(not(windows))]
    {
        Ok(bytes.to_vec())
    }
}

#[cfg(not(windows))]
fn crypt(_: &[u8], _: bool) -> io::Result<Vec<u8>> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Windows DPAPI credentials require the same Windows user",
    ))
}

#[cfg(windows)]
fn crypt(bytes: &[u8], protect: bool) -> io::Result<Vec<u8>> {
    use std::ffi::c_void;
    #[repr(C)]
    struct Blob {
        len: u32,
        data: *mut u8,
    }
    #[link(name = "crypt32")]
    unsafe extern "system" {
        fn CryptProtectData(
            input: *const Blob,
            description: *const u16,
            entropy: *const Blob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
        fn CryptUnprotectData(
            input: *const Blob,
            description: *mut *mut u16,
            entropy: *const Blob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }
    let input = Blob {
        len: bytes
            .len()
            .try_into()
            .map_err(|_| io::Error::other("credential too large"))?,
        data: bytes.as_ptr() as *mut u8,
    };
    let mut output = Blob {
        len: 0,
        data: std::ptr::null_mut(),
    };
    // CRYPTPROTECT_UI_FORBIDDEN; no machine-wide flag, so only this user can decrypt.
    let success = unsafe {
        if protect {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                1,
                &mut output,
            )
        }
    };
    if success == 0 {
        return Err(io::Error::last_os_error());
    }
    let result = unsafe { std::slice::from_raw_parts(output.data, output.len as usize).to_vec() };
    unsafe {
        LocalFree(output.data.cast());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn credentials_round_trip_without_plaintext_on_disk() {
        let input = br#"{"cookie":"test-secret"}"#;
        let encoded = super::encode(input).unwrap();
        assert!(encoded.starts_with(super::MAGIC));
        assert!(!encoded.windows(11).any(|w| w == b"test-secret"));
        assert_eq!(
            super::crypt(&encoded[super::MAGIC.len()..], false).unwrap(),
            input
        );
        let mut corrupt = encoded;
        *corrupt.last_mut().unwrap() ^= 0xff;
        assert!(super::crypt(&corrupt[super::MAGIC.len()..], false).is_err());
    }
}
