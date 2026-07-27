//! macOS 系统层：读取当前活跃应用 + 窗口标题
//!
//! - 应用级（第 1 层）：NSWorkspace.shared.frontmostApplication → app_name / bundle_id / pid
//! - 窗口标题（第 2 层）：Accessibility API (AXUIElement) 取 AXWindows[0].AXTitle
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
    // CFArray 访问（AXWindows 返回 CFArray）
    fn CFArrayGetCount(array: CFTypeRef) -> isize;
    fn CFArrayGetValueAtIndex(array: CFTypeRef, idx: isize) -> CFTypeRef;
}

// CoreGraphics：获取系统空闲时间（自上次键盘/鼠标输入以来的秒数）
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(stateID: u32, eventType: u32) -> f64;
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

/// 获取系统空闲时间（秒）：自上次键盘/鼠标输入以来经过的时间。
/// 用于空闲检测——用户离开电脑后此值持续增长。
pub fn get_system_idle_secs() -> f64 {
    unsafe {
        // kCGEventSourceStateHIDSystemState = 1
        // kCGAnyInputEventType = 0xFFFFFFFF
        CGEventSourceSecondsSinceLastEventType(1, 0xFFFFFFFF)
    }
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

/// 通过 Accessibility API 读取窗口标题：应用元素 → AXWindows[0] → AXTitle。
/// 无权限 / 失败返回 None（降级）。
fn get_window_title(pid: i32) -> Option<String> {
    unsafe {
        let app_element = AXUIElementCreateApplication(pid);
        if app_element.is_null() {
            return None;
        }

        // 第一步：取应用的 AXWindows 属性（返回 CFArray）
        let windows_attr = CFString::new("AXWindows");
        let mut windows_value: CFTypeRef = std::ptr::null();
        let err =
            AXUIElementCopyAttributeValue(app_element, windows_attr.as_concrete_TypeRef(), &mut windows_value);
        CFRelease(app_element);

        if err != 0 || windows_value.is_null() {
            return None;
        }

        // 第二步：取第一个窗口元素
        let count = CFArrayGetCount(windows_value);
        if count == 0 {
            CFRelease(windows_value);
            return None;
        }
        let window_element = CFArrayGetValueAtIndex(windows_value, 0);
        CFRelease(windows_value);

        if window_element.is_null() {
            return None;
        }

        // 第三步：取窗口的 AXTitle 属性
        let title_attr = CFString::new("AXTitle");
        let mut title_value: CFTypeRef = std::ptr::null();
        let err = AXUIElementCopyAttributeValue(
            window_element,
            title_attr.as_concrete_TypeRef(),
            &mut title_value,
        );

        if err != 0 || title_value.is_null() {
            return None;
        }

        // AXTitle 的值类型为 CFString，由 CFString 接管（+1 retain）
        let cf_str = CFString::wrap_under_create_rule(title_value as CFStringRef);
        Some(cf_str.to_string())
    }
}
