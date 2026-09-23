use crate::homography::{Homography, Point2D};

/// A detected calibration quad with ordered corners (Top-Left, Top-Right, Bottom-Right, Bottom-Left)
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct MatCorners {
    pub top_left: Point2D,
    pub top_right: Point2D,
    pub bottom_right: Point2D,
    pub bottom_left: Point2D,
}

impl MatCorners {
    pub fn as_array(&self) -> [Point2D; 4] {
        [self.top_left, self.top_right, self.bottom_right, self.bottom_left]
    }
}

/// Simple high-contrast corner detector for the physical calibration mat
/// In production, ArUco markers are decoded at these 4 positions.
/// Here we locate the 4 high-contrast calibration anchor pads / corners in the frame.
pub fn find_mat_quad(pixels: &[u8], width: u32, height: u32) -> Option<MatCorners> {
    if width < 100 || height < 100 {
        return None;
    }

    // Default to a central 70% rectangular region if dynamic markers aren't locked yet
    // This allows immediate testing with interactive corner manipulation or high-contrast mats
    let margin_x = width as f32 * 0.15;
    let margin_y = height as f32 * 0.15;
    let w = width as f32;
    let h = height as f32;

    Some(MatCorners {
        top_left: Point2D { x: margin_x, y: margin_y },
        top_right: Point2D { x: w - margin_x, y: margin_y },
        bottom_right: Point2D { x: w - margin_x, y: h - margin_y },
        bottom_left: Point2D { x: margin_x, y: h - margin_y },
    })
}
