# Research Notes and Upstream References

Observatory should borrow mature observability ideas rather than invent every trace/diagnostic convention.

## General tracing/telemetry

- OpenTelemetry — traces, metrics, logs, context propagation
  - https://opentelemetry.io/
- W3C Trace Context — interoperable trace/span propagation
  - https://www.w3.org/TR/trace-context/
- Perfetto — high-volume timeline/tracing UI and trace processor
  - https://perfetto.dev/
- Chrome Trace Event format — useful compatibility/export target for timeline tooling
  - https://chromium.googlesource.com/catapult/+/HEAD/tracing/README.md

These are references/export targets, not mandates for Observatory's domain schema.

## Inference observability inputs

Relevant upstream engines expose differing levels of metrics and internal state:

- llama.cpp — https://github.com/ggml-org/llama.cpp
- vLLM — https://github.com/vllm-project/vllm
- SGLang — https://github.com/sgl-project/sglang
- TensorRT-LLM — https://github.com/NVIDIA/TensorRT-LLM
- LMCache — https://github.com/LMCache/LMCache
- Mooncake — https://github.com/kvcache-ai/Mooncake
- FlashInfer — https://github.com/flashinfer-ai/flashinfer

The viewer must capability-negotiate rather than assume one common depth of instrumentation.

## Visualization references

Useful design precedents to study:

- Perfetto timeline/event navigation
- Nsight Systems / Nsight Compute for GPU/system profiling concepts
- Tracy profiler for low-overhead instrumentation and timeline UX
- Netron for graph/model inspection concepts
- Grafana for linked dashboards and variable/metric inspection
- distributed-tracing UIs for span parent/child relationships

The visual design should remain Sonder-specific rather than cloning any one tool.

## LLM-specific questions Observatory can answer

- What dominated time-to-first-token?
- Was decode compute-bound, memory-bound, or stalled by scheduling?
- Did context prefix reuse work?
- Why was KV evicted?
- Which agent consumed the budget?
- Did retries produce new information?
- Was duplicate work launched?
- Did compaction actually reduce context pressure?
- Which model/backend/device was active at each point?
- Did speculative decoding help or hurt?
- Did a remote node save local VRAM at the cost of network latency?

## Research discipline

When adding a visualization:
1. identify the producer field/events that support it;
2. document derivation;
3. label estimates;
4. add a replay fixture;
5. add an inspector path to the underlying evidence.
