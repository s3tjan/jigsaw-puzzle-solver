package registration

import (
	"image"
	"math"
)

// FeatureDescriptor holds illuminant-invariant chromaticity and gradient features.
type FeatureDescriptor struct {
	MeanChromaA float64
	MeanChromaB float64
	StdChromaA  float64
	StdChromaB  float64

	// Hue angle distribution (16 bins in [0, 2*pi])
	HueHist [16]float64

	// 8-bin Histogram of Oriented Gradients (HOG)
	GradientHist [8]float64
	HasGradients bool
}

// ExtractDescriptor calculates illuminant-invariant chromaticity and gradient orientation histograms.
func ExtractDescriptor(img image.Image, mask *image.Alpha) FeatureDescriptor {
	if img == nil {
		return FeatureDescriptor{}
	}

	b := img.Bounds()
	w := b.Dx()
	h := b.Dy()

	lumGrid := make([][]float64, h)
	for y := 0; y < h; y++ {
		lumGrid[y] = make([]float64, w)
	}

	var caVals, cbVals []float64
	var hueHist [16]float64

	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if mask != nil {
				mBounds := mask.Bounds()
				maskX := mBounds.Min.X + x
				maskY := mBounds.Min.Y + y
				if mask.AlphaAt(maskX, maskY).A == 0 {
					lumGrid[y][x] = -1.0
					continue
				}
			}

			r, g, bVal, a := img.At(b.Min.X+x, b.Min.Y+y).RGBA()
			if a == 0 {
				lumGrid[y][x] = -1.0
				continue
			}

			L, aLab, bLab := RGBToLab(uint8(r>>8), uint8(g>>8), uint8(bVal>>8))
			lumGrid[y][x] = L

			scale := math.Max(L, 10.0)
			ca := aLab / scale
			cb := bLab / scale

			caVals = append(caVals, ca)
			cbVals = append(cbVals, cb)

			hue := math.Atan2(bLab, aLab)
			if hue < 0 {
				hue += 2.0 * math.Pi
			}
			bin := int(hue / (2.0 * math.Pi) * 15.999)
			if bin < 0 {
				bin = 0
			} else if bin > 15 {
				bin = 15
			}
			hueHist[bin]++
		}
	}

	totalPixels := float64(len(caVals))
	if totalPixels == 0 {
		return FeatureDescriptor{}
	}

	for i := 0; i < 16; i++ {
		hueHist[i] /= totalPixels
	}

	// 2. Compute 8-bin Histogram of Oriented Gradients (Sobel filter)
	var gradHist [8]float64
	gradTotal := 0.0

	for y := 1; y < h-1; y++ {
		for x := 1; x < w-1; x++ {
			if lumGrid[y][x] < 0 || lumGrid[y-1][x] < 0 || lumGrid[y+1][x] < 0 ||
				lumGrid[y][x-1] < 0 || lumGrid[y][x+1] < 0 {
				continue
			}

			dx := lumGrid[y][x+1] - lumGrid[y][x-1]
			dy := lumGrid[y+1][x] - lumGrid[y-1][x]
			mag := math.Hypot(dx, dy)
			if mag > 3.0 {
				angle := math.Atan2(dy, dx)
				if angle < 0 {
					angle += math.Pi
				}
				bin := int(angle / math.Pi * 7.999)
				if bin < 0 {
					bin = 0
				} else if bin > 7 {
					bin = 7
				}
				gradHist[bin] += mag
				gradTotal += mag
			}
		}
	}

	hasGrads := gradTotal > 0
	if hasGrads {
		for i := 0; i < 8; i++ {
			gradHist[i] /= gradTotal
		}
	}

	var sumA, sumB float64
	for i := 0; i < len(caVals); i++ {
		sumA += caVals[i]
		sumB += cbVals[i]
	}
	meanA := sumA / totalPixels
	meanB := sumB / totalPixels

	var varA, varB float64
	for i := 0; i < len(caVals); i++ {
		dA := caVals[i] - meanA
		dB := cbVals[i] - meanB
		varA += dA * dA
		varB += dB * dB
	}

	return FeatureDescriptor{
		MeanChromaA:  meanA,
		MeanChromaB:  meanB,
		StdChromaA:   math.Sqrt(varA / totalPixels),
		StdChromaB:   math.Sqrt(varB / totalPixels),
		HueHist:      hueHist,
		GradientHist: gradHist,
		HasGradients: hasGrads,
	}
}

// MatchMetrics provides breakdown of why a piece candidate matched the artwork slot.
type MatchMetrics struct {
	HueSimilarity      float64 `json:"hue_similarity"`      // [0, 100]%
	ChromaSimilarity   float64 `json:"chroma_similarity"`   // [0, 100]%
	GradientSimilarity float64 `json:"gradient_similarity"` // [0, 100]%
	OverallConfidence  float64 `json:"overall_confidence"`  // [0, 100]%
}

// DescriptorDistanceDetailed computes visual distance and returns granular similarity percentages.
func DescriptorDistanceDetailed(d1, d2 FeatureDescriptor) (float64, MatchMetrics) {
	dChromaMean := math.Hypot(d1.MeanChromaA-d2.MeanChromaA, d1.MeanChromaB-d2.MeanChromaB)
	chromaSim := math.Max(0.0, math.Min(100.0, (1.0-math.Min(1.0, dChromaMean*2.0))*100.0))

	hueIntersection := 0.0
	for i := 0; i < 16; i++ {
		hueIntersection += math.Min(d1.HueHist[i], d2.HueHist[i])
	}
	dHue := 1.0 - hueIntersection
	hueSim := math.Max(0.0, math.Min(100.0, hueIntersection*100.0))

	gradSim := 50.0
	totalDist := 0.0

	if d1.HasGradients && d2.HasGradients {
		gradIntersection := 0.0
		for i := 0; i < 8; i++ {
			gradIntersection += math.Min(d1.GradientHist[i], d2.GradientHist[i])
		}
		dGrad := 1.0 - gradIntersection
		gradSim = math.Max(0.0, math.Min(100.0, gradIntersection*100.0))
		totalDist = 0.55*dHue + 0.25*dChromaMean + 0.20*dGrad
	} else {
		totalDist = 0.70*dHue + 0.30*dChromaMean
	}

	confidence := math.Max(0.0, math.Min(100.0, (1.0-totalDist)*100.0))

	return totalDist, MatchMetrics{
		HueSimilarity:      hueSim,
		ChromaSimilarity:   chromaSim,
		GradientSimilarity: gradSim,
		OverallConfidence:  confidence,
	}
}

// DescriptorDistance computes illuminant-invariant visual distance between two descriptors.
func DescriptorDistance(d1, d2 FeatureDescriptor) float64 {
	dist, _ := DescriptorDistanceDetailed(d1, d2)
	return dist
}
