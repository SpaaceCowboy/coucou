// Platform helpers can be exercised without a desktop or a configured service.
#[cfg(target_os = "linux")]
#[test]
fn executable_search_checks_unix_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("coucou-path-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let executable = root.join("coucou-path-fixture");
    std::fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
    let path = std::env::var_os("PATH");
    std::env::set_var("PATH", &root);
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(super::find_on_path("coucou-path-fixture").is_none());
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(super::find_on_path("coucou-path-fixture"), Some(executable));
    if let Some(path) = path {
        std::env::set_var("PATH", path);
    } else {
        std::env::remove_var("PATH");
    }
    std::fs::remove_dir_all(root).unwrap();
}
