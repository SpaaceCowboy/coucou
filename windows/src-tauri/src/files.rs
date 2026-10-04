// Dropped files are copied into %LOCALAPPDATA%\Coucou\inbox so the original is
// never touched and the copy survives the drag source going away.
// The inbox is swept of anything older than a week, as on macOS.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::settings;

const KEEP_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);

pub fn validate_attachment(path:&str,provider:&str)->Result<(),String>{
    if Path::new(path).extension().is_some_and(|e|e.eq_ignore_ascii_case("pdf")) && provider!="claude"{return Err("For PDF questions, choose Claude in Settings → Chat, or export the file as text.".into());}
    let source=Path::new(path);let meta=std::fs::metadata(source).map_err(|_|"This file is no longer available. Drop it again.")?;
    if !meta.is_file(){return Err("Drop one file. Folders and devices are unsupported.".into());}
    let ext=source.extension().and_then(|e|e.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext=="pdf"{
        if provider!="claude"{return Err("PDFs require Claude. Choose Claude in Settings → Chat, or export the file as text.".into());}
        // Base64 must fit in Claude's 32 MB request, with room for chat context.
        if meta.len()>23_000_000{return Err("This PDF is too large for an inline request. Split it into smaller PDFs (under 23 MB).".into());}
    }else if ["jpg","jpeg","png","gif","webp"].contains(&ext.as_str()){
        let limit=if provider=="claude"{5_000_000}else{8*1024*1024};
        if meta.len()>limit{return Err(format!("This image exceeds the {} MB attachment limit. Resize it before dropping it.",if provider=="claude"{5}else{8}));}
    }else{
        if meta.len()>200_000{return Err("Text and code attachments must be smaller than 200 KB. Export a short excerpt, or choose Claude for a PDF.".into());}
        let text=std::fs::read_to_string(source).map_err(|_|"This format cannot be read as text. Use UTF-8 text/code, PNG, JPEG, GIF, WebP, or a PDF with Claude. Export office documents as PDF or text.")?;
        if text.contains('\0'){return Err("This is a binary file. Export it as PDF or UTF-8 text before dropping it.".into());}
    }
    Ok(())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}

pub fn inbox_dir() -> PathBuf {
    settings::local_dir().join("inbox")
}

pub fn ingest(source: &str) -> Result<DroppedFile, String> {
    ingest_into(source,&inbox_dir())
}

fn ingest_into(source:&str,dir:&Path)->Result<DroppedFile,String> {
    let src = Path::new(source);
    let meta = std::fs::metadata(src).map_err(|e| format!("cannot read {source}: {e}"))?;
    if !meta.is_file() {
        return Err("Drop a regular file. Folders and devices are unsupported.".into());
    }

    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());

    let stem=src.file_stem().map(|s|s.to_string_lossy().to_string()).unwrap_or_default();
    let ext=src.extension().map(|s|format!(".{}",s.to_string_lossy())).unwrap_or_default();
    let mut destination=None;
    for i in 1..1000 {
        let dest=dir.join(if i==1{name.clone()}else{format!("{stem} ({i}){ext}")});
        match std::fs::File::options().write(true).create_new(true).open(&dest) {
            Ok(mut out)=>{
                let result=std::fs::File::open(src).and_then(|mut input|std::io::copy(&mut input,&mut out));
                if let Err(err)=result{drop(out);let _=std::fs::remove_file(&dest);return Err(format!("cannot copy: {err}"));}
                destination=Some(dest);break;
            }
            Err(err) if err.kind()==std::io::ErrorKind::AlreadyExists=>continue,
            Err(err)=>return Err(format!("cannot prepare file: {err}")),
        }
    }
    let dest=destination.ok_or("Too many files with this name. Clear old copies and try again.")?;
    // CopyFileEx carries the source's timestamps across, so a file last edited
    // three years ago would arrive already older than the sweep window and be
    // deleted on the spot. The inbox ages from when *we* copied it.
    if let Ok(file) = std::fs::File::options().write(true).open(&dest) {
        let _ = file.set_modified(SystemTime::now());
    }
    sweep(dir);

    Ok(DroppedFile {
        name,
        path: dest.to_string_lossy().to_string(),
        size: meta.len(),
    })
}

/// Drops anything copied here more than a week ago. `ingest` stamps every copy
/// with the time it landed, so this really is the age of the copy and not the
/// age of whatever the user happened to drag in.
fn sweep(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(copied) = meta.modified() else { continue };
        if now.duration_since(copied).map(|age| age > KEEP_FOR).unwrap_or(false) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ingest_copies_and_never_overwrites() {
        let tmp = std::env::temp_dir().join(format!("coucou-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let source = tmp.join("note.txt");
        std::fs::write(&source, b"hello").unwrap();

        let inbox=tmp.join("inbox");
        let first = ingest_into(source.to_str().unwrap(),&inbox).unwrap();
        assert_eq!(first.name, "note.txt");
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");

        // A second drop of the same name must not clobber the first copy.
        std::fs::write(&source, b"second").unwrap();
        let second = ingest_into(source.to_str().unwrap(),&inbox).unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");
        assert_eq!(std::fs::read(&second.path).unwrap(), b"second");

        // Folders are refused rather than silently ignored.
        assert!(ingest_into(tmp.to_str().unwrap(),&inbox).is_err());

        // An ancient source must not arrive already older than the sweep window.
        let old_source = tmp.join("ancient.txt");
        std::fs::write(&old_source, b"old").unwrap();
        let long_ago = SystemTime::now() - KEEP_FOR - Duration::from_secs(60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&old_source)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
        let aged = ingest_into(old_source.to_str().unwrap(),&inbox).unwrap();
        assert!(
            Path::new(&aged.path).exists(),
            "a file copied just now was swept as if it were a week old"
        );
        let _ = std::fs::remove_file(&aged.path);

        let _ = std::fs::remove_file(&first.path);
        let _ = std::fs::remove_file(&second.path);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

#[cfg(test)]
mod attachment_tests{
    use super::*;
    #[test]
    fn attachments_fail_usefully_before_network_requests(){
        let root=std::env::temp_dir().join(format!("coucou-attachments-{}",std::process::id()));std::fs::create_dir_all(&root).unwrap();
        let text=root.join("note.txt");std::fs::write(&text,"Hello").unwrap();assert!(validate_attachment(text.to_str().unwrap(),"codex").is_ok());
        let binary=root.join("archive.docx");std::fs::write(&binary,[0,255,1]).unwrap();assert!(validate_attachment(binary.to_str().unwrap(),"claude").unwrap_err().contains("format"));
        let pdf=root.join("note.pdf");std::fs::write(&pdf,"%PDF-1.7").unwrap();assert!(validate_attachment(pdf.to_str().unwrap(),"codex").unwrap_err().contains("choose Claude"));assert!(validate_attachment(pdf.to_str().unwrap(),"claude").is_ok());
        let large=root.join("large.txt");std::fs::File::create(&large).unwrap().set_len(200001).unwrap();assert!(validate_attachment(large.to_str().unwrap(),"claude").unwrap_err().contains("200 KB"));
        assert!(validate_attachment(root.to_str().unwrap(),"codex").is_err());std::fs::remove_dir_all(root).unwrap();
    }
}
