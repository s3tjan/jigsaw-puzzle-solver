package registration

import (
	"image"
	"math"
)

// FeatureDescriptor holds compact statistical color and texture features for a puzzle piece or reference tile.
type FeatureDescriptor struct {
	// Color moments (Mean and Standard Deviation for R, G, B in [0, 1])
	MeanR float64
	MeanG float64
	MeanB float64
	StdR  float64
	StdG  float64
	StdB  float64

	// 4x4x4 bin normalized color histogram (64 bins total)
	ColorHist [64]float64
}

// ExtractDescriptor calculates color moments and 3D color histogram for an image,
// masking out transparent pixels if an alpha mask is provided.
func ExtractDescriptor(img image.Image, mask *image.Alpha) FeatureDescriptor {
	if img == nil {
		return FeatureDescriptor{}
	}

	b := img.Bounds()
	var rVals, gVals, bVals []float64
	var hist [64]float64

	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			if mask != nil {
				// Translate image coordinates to mask's coordinate system if necessary
				mBounds := mask.Bounds()
				maskX := mBounds.Min.X + (x - b.Min.X)
				maskY := mBounds.Min.Y + (y - b.Min.Y)
				if mask.AlphaAt(maskX, maskY).A == 0 {
					continue
				}
			}

			r, g, b, a := img.At(x, y).RGBA()
			if a == 0 {
				continue
			}

			rf := float64(r>>8) / 255.0
			gf := float64(g>>8) / 255.0
			bf := float64(b>>8) / 255.0

			rVals = append(rVals, rf)
			gVals = append(gVals, gf)
			bVals = append(bVals, bf)

			rBin := int(rf * 3.999)
			gBin := int(gf * 3.999)
			bBin := int(bf * 3.999)
			idx := rBin*16 + gBin*4 + bBin
			hist[idx]++
		}
	}

	totalPixels := float64(len(rVals))
	if totalPixels == 0 {
		return FeatureDescriptor{}
	}

	for i := 0; i < 64; i++ {
		hist[i] /= totalPixels
	}

	var sumR, sumG, sumB float64
	for i := 0; i < len(rVals); i++ {
		sumR += rVals[i]
		sumG += gVals[i]
		sumB += bVals[i]
	}
	meanR := sumR / totalPixels
	meanG := sumG / totalPixels
	meanB := sumB / totalPixels

	var varR, varG, varB float64
	for i := 0; i < len(rVals); i++ {
		dr := rVals[i] - meanR
		dg := gVals[i] - meanG
		db := bVals[i] - meanB
		varR += dr * dr
		varG += dg * dg
		varB += db * db
	}

	return FeatureDescriptor{
		MeanR:     meanR,
		MeanG:     meanG,
		MeanB:     meanB,
		StdR:      math.Sqrt(varR / totalPixels),
		StdG:      math.Sqrt(varG / totalPixels),
		StdB:      math.Sqrt(varB / totalPixels),
		ColorHist: hist,
	}
}

// DescriptorDistance computes a normalized visual distance between two descriptors in [0, 1].
func DescriptorDistance(d1, d2 FeatureDescriptor) float64 {
	dMean := math.Sqrt(
		math.Pow(d1.MeanR-d2.MeanR, 2) +
			math.Pow(d1.MeanG-d2.MeanG, 2) +
			math.Pow(d1.MeanB-d2.MeanB, 2),
	) / math.Sqrt(3.0)

	dStd := math.Sqrt(
		math.Pow(d1.StdR-d2.StdR, 2) +
			math.Pow(d1.StdG-d2.StdG, 2) +
			math.Pow(d1.StdB-d2.StdB, 2),
	) / math.Sqrt(3.0)

	intersection := 0.0
	for i := 0; i < 64; i++ {
		intersection += math.Min(d1.ColorHist[i], d2.ColorHist[i])
	}
	histDist := 1.0 - intersection

	return 0.5*dMean + 0.2*dStd + 0.3*histDist
}
