//! macOS 系统层：读取当前活跃应用 + 窗口标题
//!
//! - 应用级（第 1 层）：NSWorkspace.shared.frontmostApplication → app_name / bundle_id / pid
//! - 窗口标题（第 2 层）：Accessibility API (AXUIElement) 取 kAXTitleAttribute
//!
//! 标题采集需要"辅助功能"权限；未授权或失败时降级为 None，不影响应用级采集。

use core_foundation::base::{CFTypeRef, TCFType};
use core_foundation::string::{CFString, CFStringRef};
use objc2_app_kit::NSWorkspace;

// Accessibility API 位于 ApplicationServices 框架（HIServices 子框架）
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef; // 实际为 AXUIElementRef，与 CFTypeRef 兼容
    fn AXUIElementCopyAttributeValue(
        element: CFTypeRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> i32; // AXError：0 = kAXErrorSuccess
    fn AXIsProcessTrusted() -> u8; // macOS Boolean
    fn CFRelease(cf: CFTypeRef);
}

pub struct ActiveApp {
    pub app_name: String,
    pub bundle_id: String,
    pub pid: i32,
    pub window_title: Option<String>,
}

/// 检测当前进程是否已获得"辅助功能"权限
pub fn check_accessibility_trusted() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
}

/// 读取当前活跃应用信息 + 窗口标题
pub fn get_active_app() -> Option<ActiveApp> {
    let workspace = NSWorkspace::sharedWorkspace();
    let frontmost = workspace.frontmostApplication()?;
    let app_name = frontmost
        .localizedName()
        .map(|s| s.to_string())
        .unwrap_or_default();
    let bundle_id = frontmost
        .bundleIdentifier()
        .map(|s| s.to_string())
        .unwrap_or_default();
    let pid = frontmost.processIdentifier();

    // pid <= 0 表示拿不到进程（理论上 frontmost 不会），跳过标题采集
    let window_title = if pid > 0 {
        get_window_title(pid)
    } else {
        None
    };

    Some(ActiveApp {
        app_name,
        bundle_id,
        pid,
        window_title,
    })
}

/// 通过 Accessibility API 读取窗口标题；无权限 / 失败返回 None（降级）
fn get_window_title(pid: i32) -> Option<String> {
    unsafe {
        let element = AXUIElementCreateApplication(pid);
        if element.is_null() {
            return None;
        }
        let attr = CFString::new("AXTitle");
        let mut value: CFTypeRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(element, attr.as_concrete_TypeRef(), &mut value);
        // element 自己 release；value 若成功返回则是 +1 retain，由 CFString 接管
        CFRelease(element);
        if err != 0 || value.is_null() {
            return None;
        }
        // kAXTitleAttribute 的值类型为 CFString
        let cf_str = CFString::wrap_under_create_rule(value as CFStringRef);
        Some(cf_str.to_string())
    }
}
