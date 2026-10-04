// API keys live in the system credential store, never in plaintext files or in
// the front end — the island can only ask whether a key is present.

use keyring::Entry;

const SERVICE: &str = "fr.louisraille.coucou";

fn storage_ready()->Result<(),String>{
    #[cfg(target_os="linux")]{
        // Check the collection without unlocking it. keyring's get_password
        // otherwise requests an unlock dialog during background monitoring.
        let output=std::process::Command::new("gdbus").args(["call","--session","--timeout","1","--dest","org.freedesktop.secrets","--object-path","/org/freedesktop/secrets/aliases/default","--method","org.freedesktop.DBus.Properties.Get","org.freedesktop.Secret.Collection","Locked"])
            .stderr(std::process::Stdio::null()).output().map_err(|_|"Linux Secret Service is unavailable. Start GNOME Keyring and reconnect in Settings.")?;
        if !output.status.success(){return Err("Linux Secret Service is unavailable. Start GNOME Keyring and reconnect in Settings.".into());}
        if !String::from_utf8_lossy(&output.stdout).contains("false"){return Err("Your keyring is locked. Unlock it in Passwords and Keys, then reconnect in Settings.".into());}
    }
    Ok(())
}

/// Every key Coucou may store. Anything outside this list is refused.
pub const KNOWN_KEYS: &[&str] = &[
    "anthropic-api-key",
    "clickup-api-token",
    "n8n-url",
    "n8n-api-key",
    "vercel-token",
    "github-token",
    "stripe-api-key",
    "resend-api-key",
    "notion-api-key",
    "calcom-api-key",
];

fn entry(key: &str) -> Option<Entry> {
    if !KNOWN_KEYS.contains(&key) {
        return None;
    }
    Entry::new(SERVICE, key).ok()
}

pub fn get(key: &str) -> Option<String> {
    storage_ready().ok()?;
    entry(key)?.get_password().ok().filter(|v| !v.is_empty())
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    storage_ready()?;
    if value.is_empty(){return clear(key);}
    let entry = entry(key).ok_or_else(|| format!("unknown key {key}"))?;
    entry.set_password(value).map_err(|e| e.to_string())
}

pub fn clear(key: &str) -> Result<(), String> {
    storage_ready()?;
    let entry = entry(key).ok_or_else(|| format!("unknown key {key}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn present(key: &str) -> bool {
    get(key).is_some()
}

pub fn status(key:&str)->Result<bool,String>{
    storage_ready()?;
    let item=entry(key).ok_or("Credential storage is unavailable.")?;
    credential_status(item.get_password())
}

fn credential_status(result:Result<String,keyring::Error>)->Result<bool,String>{
    match result{Ok(value)=>Ok(!value.is_empty()),Err(keyring::Error::NoEntry)=>Ok(false),Err(_)=>Err("Unlock your system keyring and try connecting again.".into())}
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn absent_credentials_and_storage_failures_are_distinct(){
        assert_eq!(credential_status(Err(keyring::Error::NoEntry)),Ok(false));
        assert_eq!(credential_status(Ok(String::new())),Ok(false));
        assert_eq!(credential_status(Ok("test-value".into())),Ok(true));
        let denied=keyring::Error::NoStorageAccess(Box::new(std::io::Error::new(std::io::ErrorKind::PermissionDenied,"locked")));
        assert!(credential_status(Err(denied)).unwrap_err().contains("keyring"));
    }
}
