package registration

import "math"

// RGBToLab converts standard 8-bit sRGB to CIE L*a*b* under D65 standard illuminant.
// Returns:
// L: [0, 100] (Perceived lightness)
// a: approx [-128, 127] (Green to Red axis)
// b: approx [-128, 127] (Blue to Yellow axis)
func RGBToLab(r, g, b uint8) (float64, float64, float64) {
	// 1. sRGB to linear RGB
	lr := sRGBToLinear(float64(r) / 255.0)
	lg := sRGBToLinear(float64(g) / 255.0)
	lb := sRGBToLinear(float64(b) / 255.0)

	// 2. Linear RGB to CIE XYZ (D65 matrix)
	x := lr*0.4124564 + lg*0.3575761 + lb*0.1804375
	y := lr*0.2126729 + lg*0.7151522 + lb*0.0721750
	z := lr*0.0193339 + lg*0.1191920 + lb*0.9503041

	// D65 reference white point
	const (
		xn = 0.95047
		yn = 1.00000
		zn = 1.08883
	)

	fx := fLab(x / xn)
	fy := fLab(y / yn)
	fz := fLab(z / zn)

	// 3. CIE XYZ to CIE L*a*b*
	L := 116.0*fy - 16.0
	aLab := 500.0 * (fx - fy)
	bLab := 200.0 * (fy - fz)

	return L, aLab, bLab
}

func sRGBToLinear(c float64) float64 {
	if c <= 0.04045 {
		return c / 12.92
	}
	return math.Pow((c+0.055)/1.055, 2.4)
}

func fLab(t float64) float64 {
	const (
		delta = 6.0 / 29.0
		lim   = delta * delta * delta
	)
	if t > lim {
		return math.Cbrt(t)
	}
	return t/(3.0*delta*delta) + 4.0/29.0
}
