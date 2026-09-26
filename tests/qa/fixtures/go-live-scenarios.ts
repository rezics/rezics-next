// Main modules resolved against one live proxy.golang.org capture. The capture is
// `tests/live/go-proxy-live.test.ts`; native Go 1.27.1 results for the same bytes
// come from `yarn package:go-oracle`.

export interface GoLiveScenario { id: string; mainModule: string }

export const GO_LIVE_SCENARIOS: GoLiveScenario[] = [
  // A retracted root with a rationale block, an interval retraction without a
  // rationale, a go 1.13 (unpruned) branch expanded transitively, /vN and
  // gopkg.in major paths.
  { id: 'retract-major-unpruned', mainModule: `module example.com/rezics/live

go 1.22

toolchain go1.22.5

godebug default=go1.21

require (
	github.com/go-chi/chi/v5 v5.0.12
	github.com/klauspost/compress v1.14.2 // retracted upstream
	github.com/sirupsen/logrus v1.8.1
	google.golang.org/grpc v1.74.0
	gopkg.in/yaml.v3 v3.0.1 // indirect
)
` },
  // Roots below the graph's selection are raised and their newer go.mod loaded.
  { id: 'root-stabilization', mainModule: `module example.com/rezics/stabilize

go 1.21

require (
	golang.org/x/net v0.1.0
	golang.org/x/text v0.3.0
	google.golang.org/grpc v1.74.1
)
` },
];
