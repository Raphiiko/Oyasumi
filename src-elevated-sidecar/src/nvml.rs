use std::sync::Mutex;

use log::{error, info};
use nvml_wrapper::Nvml;
use oyasumi_shared::models::NVMLDevice;

lazy_static! {
    static ref NVML_STATUS: Mutex<String> = Mutex::new(String::from("INITIALIZING"));
    static ref NVML_HANDLE: Mutex<Option<Nvml>> = Default::default();
}

pub fn init() -> bool {
    info!("[NVML] Initializing NVML");
    match Nvml::init() {
        Ok(nvml) => {
            info!("[NVML] Successfully initialized NVML");
            *NVML_HANDLE.lock().unwrap() = Some(nvml);
            *NVML_STATUS.lock().unwrap() = String::from("INIT_COMPLETE");
            true
        }
        Err(err) => {
            *NVML_HANDLE.lock().unwrap() = None;
            error!("[NVML] Could not initialize NVML: {}", err);
            match err {
                nvml_wrapper::error::NvmlError::DriverNotLoaded => {
                    *NVML_STATUS.lock().unwrap() = String::from("DRIVER_NOT_LOADED");
                }
                nvml_wrapper::error::NvmlError::LibloadingError(_) => {
                    *NVML_STATUS.lock().unwrap() = String::from("LIB_LOADING_ERROR");
                }
                nvml_wrapper::error::NvmlError::NoPermission => {
                    *NVML_STATUS.lock().unwrap() = String::from("NO_PERMISSION");
                }
                nvml_wrapper::error::NvmlError::Unknown => {
                    *NVML_STATUS.lock().unwrap() = String::from("NVML_UNKNOWN_ERROR");
                }
                _ => {
                    *NVML_STATUS.lock().unwrap() = String::from("UNKNOWN_ERROR");
                }
            };
            false
        }
    }
}

pub async fn nvml_status() -> String {
    NVML_STATUS.lock().unwrap().clone()
}

pub fn nvml_get_devices() -> Vec<NVMLDevice> {
    let nvml_guard = NVML_HANDLE.lock().unwrap();
    let nvml = nvml_guard.as_ref().unwrap();
    let count = nvml.device_count().unwrap();
    let mut gpus: Vec<NVMLDevice> = Vec::new();
    for n in 0..count {
        let device = match nvml.device_by_index(n) {
            Ok(device) => device,
            Err(err) => {
                error!(
                    "[NVML] Could not access GPU at index {} due to an error: {:#?}",
                    n, err
                );
                continue;
            }
        };
        let constraints = device.power_management_limit_constraints().ok();
        gpus.push(NVMLDevice {
            uuid: device.uuid().unwrap(),
            name: device.name().unwrap(),
            power_limit: device.power_management_limit().ok(),
            min_power_limit: constraints.as_ref().and_then(|c| Some(c.min_limit)),
            max_power_limit: constraints.as_ref().and_then(|c| Some(c.max_limit)),
            default_power_limit: device.power_management_limit_default().ok(),
        });
    }
    gpus
}

pub async fn nvml_set_power_management_limit(uuid: String, limit: u32) -> Result<bool, String> {
    let nvml_guard = NVML_HANDLE.lock().unwrap();
    let nvml = nvml_guard.as_ref().unwrap();

    let mut device = match nvml.device_by_uuid(uuid.clone()) {
        Ok(device) => device,
        Err(err) => {
            error!(
                "[NVML] Could not access GPU (uuid:{:#?}) due to an error: {:#?}",
                uuid, err
            );
            return Err(String::from("DEVICE_ACCESS_ERROR"));
        }
    };

    match device.set_power_management_limit(limit) {
        Err(err) => {
            error!(
                "[NVML] Could not set power limit for GPU (uuid:{:#?}) due to an error: {:#?}",
                uuid.clone(),
                err
            );
            return Err(String::from("DEVICE_SET_POWER_LIMIT_ERROR"));
        }
        _ => (),
    }

    Ok(true)
}
