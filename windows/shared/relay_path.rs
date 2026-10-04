// Shared by the desktop and relay. Never place a socket in a public directory.
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::{io, path::PathBuf};
pub fn socket_path() -> io::Result<PathBuf> {
    let uid = unsafe { libc::geteuid() };
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|p| {
            std::fs::symlink_metadata(p)
                .is_ok_and(|m| m.is_dir() && m.uid() == uid && m.permissions().mode() & 0o077 == 0)
        })
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                "A private XDG_RUNTIME_DIR is required for Claude hooks",
            )
        })?;
    Ok(runtime.join("coucou-hook.sock"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runtime_directory_must_be_private_owned_and_not_a_symlink() {
        let original = std::env::var_os("XDG_RUNTIME_DIR");
        let temp = std::env::temp_dir().join(format!(
            "coucou-runtime-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&temp).unwrap();
        std::env::set_var("XDG_RUNTIME_DIR", &temp);
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(socket_path().is_err());
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(socket_path().unwrap(), temp.join("coucou-hook.sock"));
        let link = temp.with_extension("link");
        std::os::unix::fs::symlink(&temp, &link).unwrap();
        std::env::set_var("XDG_RUNTIME_DIR", &link);
        assert!(socket_path().is_err());
        match original {
            Some(value) => std::env::set_var("XDG_RUNTIME_DIR", value),
            None => std::env::remove_var("XDG_RUNTIME_DIR"),
        }
        std::fs::remove_file(link).unwrap();
        std::fs::remove_dir(temp).unwrap();
    }
}
