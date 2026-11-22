#[cfg(any(test, all(windows, target_arch = "x86_64")))]
mod protocol;
#[cfg(any(test, all(windows, target_arch = "x86_64")))]
mod visibility;
#[cfg(all(windows, target_arch = "x86_64"))]
mod windows;

#[cfg(all(windows, target_arch = "x86_64"))]
fn main() -> std::process::ExitCode {
    match windows::run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("REZICS Overlay: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}

#[cfg(not(all(windows, target_arch = "x86_64")))]
fn main() -> std::process::ExitCode {
    eprintln!("REZICS Overlay requires 64-bit Windows and WebView2.");
    std::process::ExitCode::FAILURE
}
