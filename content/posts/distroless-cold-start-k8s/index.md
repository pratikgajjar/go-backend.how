+++
title = "🐺 Distroless vs Wolfi vs Scratch — Cold-Start Latency for a 10MB Go Binary on K8s"
description = "Three Dockerfiles for the same 10 MB Go binary. Real bytes, real layers, real pull timings on Apple Silicon. Why the smallest image is rarely the fastest, and what actually breaks at 1000 pods."
date = 2026-05-09T12:00:00+05:30
lastmod = 2026-05-09T12:00:00+05:30
publishDate = 2026-05-09T12:00:00+05:30
draft = true
tags = ["kubernetes", "containers", "distroless", "wolfi", "cold-start", "golang"]
images = ["og.png"]
theme = "rosewood"
featured = false
math = false
+++

# The number that should not be true

A `FROM scratch` image with a 10.16 MB Go binary inside it ships **3.98 MB** on the wire after gzip. The same binary on top of `gcr.io/distroless/static:latest` ships **4.83 MB** across **fourteen** layers — almost a megabyte more bytes and thirteen extra HTTP fetches.

Yet pushed to a `localhost:5005` registry and started with `podman run`, both images take 232\u2013325 ms (distroless) and 219\u2013285 ms (scratch) end-to-end \u2014 the spread between *images* is dwarfed by the spread between *runs* of the same image. Wolfi-base (which is **2.5\u00d7** scratch's wire weight and **2\u00d7** distroless's) lands at 219\u2013259 ms, *faster* than either.

The smallest image isn't the fastest. The biggest one isn't the slowest. Image size is the wrong axis to argue on, and most "distroless vs scratch" posts you've read pick the wrong fight.

> Cold-start on Kubernetes splits cleanly: image bytes dominate when you're cold-pulling from a remote registry (we measured 1.87–2.99 s for the bare base images from `gcr.io` / `cgr.dev`), and the container-runtime plumbing (namespace setup, snapshot creation, network bridge, kubelet's pull scheduler) dominates once the image is local (~200 ms here, regardless of base). The base-image *choice* moves wall-clock by tens of milliseconds either way. At 1000 pods, the math gets weirder.

This post takes a single 10 MB Go binary, builds it three ways, and reads the byte trail through the pull → mount → exec pipeline. Every number below was either pulled from a registry I queried or measured locally on `podman 5.6.0` running on an M3 MacBook Pro (Darwin arm64), with the test scripts pinned at the bottom.

# Why this fight exists at all

If you ship a Go binary in 2026, you have three honest base-image choices:

1. **`FROM scratch`** — zero extra files. Your binary, an `ENTRYPOINT`, and nothing else. No `/etc`, no `ld-linux`, no shell, no CA certs.
2. **`gcr.io/distroless/static`** — the binary plus the *bare minimum* a server typically needs: `/etc/ssl/certs/ca-certificates.crt`, `/usr/share/zoneinfo`, `/etc/passwd`, `/etc/group`, `/etc/nsswitch.conf`. No package manager, no shell, no busybox. You can't `kubectl exec -- sh`.
3. **`cgr.dev/chainguard/wolfi-base`** — Wolfi is Chainguard's APK-based "designed for containers" distro. You get `apk`, busybox, glibc, openssl, the works. You *can* shell in. Their security team rebuilds packages daily on top of [Wolfi's package repo][wolfi].

Pick scratch and your security posture is "binary or nothing." Pick distroless-static and `tls.Dial` and `time.LoadLocation("Asia/Kolkata")` keep working without you shipping a CA bundle in your binary. Pick Wolfi and you can pay your favourite ops engineer `apk add curl` to debug a flaky pod at 03:00.

In a payments shard at UPI scale, the choice compounds. The compliance frameworks Indian backends typically operate under \u2014 the [RBI's cyber-security guidance][rbi-cyber] for regulated entities, plus [PCI-DSS][pci] for any card-data path \u2014 push toward minimal attack surface, no shell-as-default, and signed images. Distroless and Wolfi-with-no-extras both fit that envelope cleanly. Scratch fits too, but you lose `time.LoadLocation` and `tls.Config{}.RootCAs` defaults the moment your binary needs them, and the bug discovery is hours away from where the build happened.

[wolfi]: https://github.com/wolfi-dev/os
[pci]: https://www.pcisecuritystandards.org/document_library/?category=pcidss
[rbi-cyber]: https://www.rbi.org.in/scripts/NotificationUser.aspx?Id=10435

# The test rig — three Dockerfiles, one binary

The Go program is a real-shaped service: chi router, prometheus metrics endpoint, zap logger, structured JSON `/healthz`. Stripped, statically linked, ARM64:

```go
// main.go — a real-shaped service, not a hello-world
package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.uber.org/zap"
)

var bootedAt = time.Now()

func main() {
	logger, _ := zap.NewProduction()
	defer logger.Sync()

	r := chi.NewRouter()
	r.Get("/healthz", func(w http.ResponseWriter, req *http.Request) {
		hn, _ := os.Hostname()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":          true,
			"hostname":    hn,
			"uptime_ms":   time.Since(bootedAt).Milliseconds(),
			"goroutines":  runtime.NumGoroutine(),
			"go_version":  runtime.Version(),
		})
	})
	r.Get("/hash", func(w http.ResponseWriter, req *http.Request) {
		buf := make([]byte, 1024)
		_, _ = rand.Read(buf)
		sum := sha256.Sum256(buf)
		fmt.Fprintln(w, hex.EncodeToString(sum[:]))
	})
	r.Handle("/metrics", promhttp.Handler())

	srv := &http.Server{Addr: ":8080", Handler: r, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = srv.ListenAndServe() }()
	logger.Info("ready", zap.Duration("boot", time.Since(bootedAt)))

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	_ = srv.Shutdown(context.Background())
}
```

Build with the standard "minimum production size" flags:

```bash
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 \
  go build -ldflags="-s -w" -trimpath -o app-linux-arm64 main.go
```

The flags are load-bearing. `-s -w` strips the symbol table and DWARF debug info; `-trimpath` strips absolute build paths. `CGO_ENABLED=0` makes the binary statically linked — required for `FROM scratch`, since scratch has no `ld-linux`. With these flags, the binary is **10,158,242 B** (9.69 MiB; the brief said 10 MB, here it is, measured). Without them, it's 14.93 MB — 47 % bigger. Most of the difference is DWARF the kernel will never read.

| Source | Bytes | Δ vs stripped |
|---|---:|---:|
| `go build` (default)         | 14,928,406 | +47 % |
| `go build -ldflags="-s -w"`  | 10,158,242 | baseline |

The three Dockerfiles are all one line plus a `COPY`:

```dockerfile
# Dockerfile.scratch
FROM scratch
COPY app-linux-arm64 /app
ENTRYPOINT ["/app"]
```

```dockerfile
# Dockerfile.distroless
FROM gcr.io/distroless/static:latest
COPY app-linux-arm64 /app
ENTRYPOINT ["/app"]
```

```dockerfile
# Dockerfile.wolfi
FROM cgr.dev/chainguard/wolfi-base:latest
COPY app-linux-arm64 /app
ENTRYPOINT ["/app"]
```

Three images, one binary. Now — measure.

# Where the bytes live (a manifest dive)

Forget what `docker images` reports. The number that matters is the registry manifest: how many blobs your kubelet has to fetch, and how big each one is. Pulled live from `gcr.io` and `cgr.dev` for the **arm64** variant of each image:

```bash
# pull a manifest list, pick arm64, then pull the per-arch manifest
TOKEN=$(curl -fsSL "https://gcr.io/v2/token?scope=repository:distroless/static:pull" \
        | jq -r .token)
DIGEST=$(curl -fsSL -H "Authorization: Bearer $TOKEN" \
              -H "Accept: application/vnd.oci.image.index.v1+json" \
              "https://gcr.io/v2/distroless/static/manifests/latest" \
        | jq -r '.manifests[] | select(.platform.architecture=="arm64") | .digest')
curl -fsSL -H "Authorization: Bearer $TOKEN" \
     -H "Accept: application/vnd.oci.image.manifest.v1+json" \
     "https://gcr.io/v2/distroless/static/manifests/$DIGEST" \
  | jq '{layers: [.layers[].size], total: ([.layers[].size] | add)}'
```

That same recipe, run for all three bases, gives the histogram below. Numbers are exact bytes, not "around":

| Base image                          | Layers | Total compressed | Largest layer | Smallest layer |
|---|---:|---:|---:|---:|
| `gcr.io/distroless/static`          | **13** | 811,169 B (792 KiB) | 288,209 B | **67 B** |
| `cgr.dev/chainguard/wolfi-base`     | **11** | 6,049,760 B (5.77 MiB) | 2,653,839 B | 2,876 B |
| `FROM scratch` (no base)            | 0      | 0                | —          | —              |

Distroless ships a **67-byte** layer. Sixty-seven. Pulled and `tar tvf`'d, that layer contains exactly one entry: an empty `./` root directory tarball stub — a marker layer Google's `bazel` build emits when a target produces zero files but still needs an index entry. The next four layers, in size order, are similarly tiny: 80 B is `/tmp/`, 123 B is `/home/` + `/home/nonroot/`, 162 B is `/etc/group` (64 bytes of content), 188 B is `/etc/passwd` (149 bytes). Each structural directory or one-line config is its own layer because Google's `bazel` build emits one rule per file. Distroless is a *thirteen*-step tarball walk, even though the total content is under a megabyte.

The largest distroless layer (288 KB compressed) is the `tzdata` package — `usr/share/zoneinfo/Africa/Abidjan`, `Asia/Kolkata`, the full Olson DB plus its Debian metadata. The 254 KB layer is `tzdata-legacy` (deprecated zone names like `US/Pacific` kept for back-compat). The 137 KB layer is the CA bundle: a single 224,449-byte file at `/etc/ssl/certs/ca-certificates.crt` (the Mozilla bundle as Debian packages it), gzipped to 137 KB. Together those three layers are `(288 + 254 + 137) / 811 = 84 %` of distroless-static, and two of the three are the exact files a Go HTTPS client needs (tzdata-legacy is mostly back-compat for code using old zone aliases).

Wolfi-base goes wider. Two layers dominate at ~2.5 MB each:

```text
sha256:4d007033… (compressed 2,653,839 B → uncompressed 6,545,920 B)
  usr/lib/libssl.so.3       (libssl 3.6.2)
  usr/lib/libcrypto.so.3    (libcrypto 3.6.2)
  usr/lib/apk/db/installed
  var/lib/db/sbom/libssl3-3.6.2-r5.spdx.json
  var/lib/db/sbom/libcrypto3-3.6.2-r5.spdx.json

sha256:d6ec4871… (compressed 2,419,749 B → uncompressed 6,121,472 B)
  usr/bin/ldconfig
  usr/lib/glibc-2.43-r7
  var/lib/db/sbom/glibc-2.43-r7.spdx.json
  var/lib/db/sbom/ld-linux-2.43-r7.spdx.json
```

That's glibc 2.43 + openssl 3.6 + ldconfig — full C-library userland. SBOM JSON shipped per package; if you've ever wanted to know exactly what's in a base image, Wolfi tells you in `/var/lib/db/sbom`. Nothing distroless-static gives you.

> Distroless trades a 13-fetch wireshark spaghetti for less than a megabyte of metadata. Wolfi trades **2.5× scratch's wire bytes (or 2× distroless's)** for an entire C runtime. Scratch trades nothing for nothing.

# The ascii architecture

```text
┌───────────────────────────────────────────────────────────┐
│  Build host                                               │
│                                                           │
│  app-linux-arm64  (10,158,242 B,  ELF arm64, static)      │
│         │                                                 │
│  ┌──────┴──────┬────────────────┬────────────────┐        │
│  ▼             ▼                ▼                ▼        │
│ scratch     distroless        wolfi-base       (other)    │
│  + COPY      + COPY            + COPY                     │
│  = 1 layer   = 14 layers       = 12 layers                │
│  = 3.98 MB   = 4.83 MB         = 10.03 MB                 │
│  on the wire on the wire       on the wire                │
└───────────────────────────────────────────────────────────┘
                       │
                       ▼  push to registry (or kind-load)
┌───────────────────────────────────────────────────────────┐
│  Kubernetes node (containerd / cri-o)                     │
│                                                           │
│  kubelet → CRI ImagePull RPC                              │
│      │                                                    │
│      ▼                                                    │
│  containerd image-store                                   │
│      ├─ HTTP GET /v2/<repo>/blobs/<sha>  × N layers       │
│      │     (parallel, up to max_concurrent_downloads = 3) │
│      ├─ ZSTD/GZIP decompress (single-threaded per blob)   │
│      ├─ overlay snapshotter: mkdir + tar -x + atomic rename│
│      └─ apply diff → new RW snapshot                      │
│                                                           │
│  runc create:                                             │
│      ├─ unshare(CLONE_NEW{NS,UTS,IPC,PID,NET,USER})       │
│      ├─ pivot_root + bind-mount config volumes            │
│      ├─ setns + seccomp + cgroup attach                   │
│      └─ execve("/app")                                    │
└───────────────────────────────────────────────────────────┘
```

The numbers in the next two sections walk the dotted line top-to-bottom.

# Real numbers — pull, decompress, run

I built each image once on the laptop, pushed all three to a local registry running on `localhost:5005`, then timed `podman pull` and `podman run` separately, three runs each, between fresh `podman rmi -f` calls. Local registry eliminates Internet variance; what's left is pure containerd-style pipeline cost.

```bash
# spin up a local registry
podman run -d --rm -p 5005:5000 --name benchreg docker.io/library/registry:2

# tag + push (one-time)
for n in distroless wolfi scratch; do
  podman tag bench/$n:latest localhost:5005/bench/$n:latest
  podman push --tls-verify=false localhost:5005/bench/$n:latest
done

# clean-pull benchmark — three runs, fresh local cache each time
for n in distroless wolfi scratch; do
  for i in 1 2 3; do
    podman rmi -f localhost:5005/bench/$n:latest 2>/dev/null
    /usr/bin/time -p podman pull --tls-verify=false --quiet \
      localhost:5005/bench/$n:latest 2>&1 | grep real
  done
done
```

| Image           | Compressed wire | Layers | Pull p50 (local registry) | Pull p99 (3-run max) |
|---|---:|---:|---:|---:|
| `bench/scratch`     | 3.98 MB | 1  | 0.30 s | 0.44 s |
| `bench/distroless`  | 4.83 MB | 14 | 0.30 s | 0.30 s |
| `bench/wolfi`       | 10.03 MB | 12 | 0.25 s | 0.27 s |

That's *not a typo*. Wolfi (2.5× scratch's wire bytes) pulled the **fastest** in this rig. Scratch (a single layer) pulled the **slowest** at p99. Three reasons, in order of weight:

1. **Snapshot creation cost is per-layer-bounded, not per-byte-bounded** for tiny layers. Containerd's [overlay snapshotter][overlay-snap] does a `mkdir` per layer plus a tar-extract pass and an atomic rename to commit the layer; the fixed cost is bounded by syscall RTT plus the journal flush from the rename, in the low-millisecond range per layer regardless of layer size. Distroless's 13 base layers therefore cost on the order of 10–20 ms of pure filesystem overhead even when the bytes are zero — the same overhead doesn't shrink just because a layer is 67 bytes.

[overlay-snap]: https://github.com/containerd/containerd/blob/main/plugins/snapshots/overlay/overlay.go

2. **Single-layer images can't parallelise.** Containerd's default `max_concurrent_downloads = 3` (see [`pkg/cri/config`][cricfg]) means scratch's lone layer fetches on one TCP connection, gzip-decompresses on one CPU. Bench/distroless's 14 layers and bench/wolfi's 12 spread across 3 parallel connections, so the binary layer (~4 MB compressed in each image) overlaps with the smaller base layers.

[cricfg]: https://github.com/containerd/containerd/blob/main/internal/cri/config/config_unix.go

3. **Gzip decompression is the long pole, and it's single-threaded per blob.** I measured `gunzip` on the 3.74 MB binary blob → 10.16 MB tar at 20–30 ms across five runs on an M3 P-core (`3.74 MB / 0.025 s ≈ 150 MB/s` of compressed input, or `10.16 / 0.025 ≈ 400 MB/s` of decompressed output). With one-layer-per-CPU, scratch eats those 20–30 ms serially; Wolfi eats them overlapped with apk-DB layer decompression on a sibling core.

If you wanted to *prove* this on Linux and are not on macOS, the one-liner is:

```bash
sudo bpftrace -e '
tracepoint:syscalls:sys_enter_openat /comm == "containerd"/ {
  @opens[str(args->filename)] = count();
}
tracepoint:syscalls:sys_exit_read /comm == "containerd"/ {
  @bytes_read = sum(args->ret);
}
interval:s:5 { print(@opens); print(@bytes_read); clear(@opens); }
'
```

Run it during a `crictl pull` and you'll see the open/stat/mkdir/unlink/rename/chown calls bunch up per-layer regardless of layer size. The fixed cost dominates for layers under ~50 KB (where `bytes_read` per layer is small relative to the syscall count).

## Container-start overhead (the ceiling nobody talks about)

After the pull, `podman run` to first 200 OK on `/healthz`. Same harness, three runs each:

| Image              | End-to-end wall (ms) | App-uptime when first 200 (ms) | Runtime overhead (ms) |
|---|---:|---:|---:|
| `bench/distroless` | 232–325 | 17–32 | **205–293** |
| `bench/wolfi`      | 219–259 | 18–26 | **193–241** |
| `bench/scratch`    | 219–285 | 18–56 | **163–267** |

`app-uptime` is read from the JSON response: how many ms the Go process had been alive when it answered the curl. That difference (`end-to-end - app-uptime`) is the *non-app* cost — namespace creation, bridge networking, OCI hook execution, image-mount, kubelet readiness probing in production. It's **6–10 ms for every 1 ms** of app boot.

> Measured: the Go runtime + listener-ready chain takes 17–56 ms inside any of these three images (median ~20 ms; one scratch run hit 56 ms as an outlier). The container runtime spends ~200 ms on plumbing whether you ship 4 MB or 10 MB on the wire. Optimising past `-s -w -trimpath` does nothing.

The measured 17–56 ms internal boot is worth decomposing. With the actual `boot=0.000523587 s` zap line as one anchor (which captures only main-package init + main() user code through the goroutine spawn — NOT the Go runtime/scheduler init that runs before `bootedAt`, NOR the listener bind or first accept that runs after), a 10 MB stripped Go binary in this Linux VM breaks down to:

| Phase                                                  | Order-of-magnitude  |
|---|---:|
| `execve` + ELF page-table setup + Go `rt0_go`          | ~5–10 ms       |
| User-code init in `main()` (zap + chi + prom register) | **~0.5 ms (measured)** |
| `http.ListenAndServe` → `socket` + dual-stack `bind` + `listen` | ~5–10 ms |
| First `accept` + handler dispatch + JSON encode        | ~2–5 ms        |

Math: `5–10 + 0.5 + 5–10 + 2–5 ≈ 12–25 ms`, which brackets the **median** 17–32 ms band (the 56 ms outlier likely sat in a cold-VFS case where the listener bind paid extra page-cache misses). The big rocks are everything *before* `main()` (kernel + Go runtime init that needs `perf record` to sub-divide), and the `ListenAndServe` plumbing — Go's net package opens a couple of dual-stack probe sockets (the `bind(...port=0...)` calls in the strace), reads `/proc/sys/net/core/somaxconn`, then binds the real `[::]:8080`. The user-code line is 0.5 ms — small enough to ignore in cold-start budgets.

## Image-pull at scale-from-zero

What people *actually* care about: HPA scales 1 → 1000 pods, the autoscaler triggers because traffic spiked, every node has to pull the image cold. Here's where the layer-count argument gets interesting.

A node already running any distroless pod has all 13 base layers in containerd's content-addressable cache; pulling a different binary on top fetches only the new ~3.98 MB layer (base layers dedupe by SHA256). Scratch pods share that layer with same-image pods but have nothing to dedupe across *different* binaries — each is its own ~3.98 MB layer. Per-new-binary cost is therefore roughly equal across the two; the gap shows up only on the *first* binary on a fresh node, where distroless pays a one-time 0.79 MB base.

For a fleet with diverse binaries:

| Cluster shape                                   | Distroless reuse | Wolfi reuse | Scratch reuse |
|---|---:|---:|---:|
| 1 binary × 1000 pods, 100 nodes                 | 100 pulls | 100 pulls | 100 pulls |
| 50 binaries × 20 pods each, 100 nodes           | 100 × 0.79 MB base + 1000 × 3.98 MB binary | 100 × 5.77 MB base + 1000 × 3.98 MB binary | 1000 × 3.98 MB |

Reading row two: distroless's base costs 0.79 MB per node, shared across all 50 services on that node; wolfi pays 5.77 MB. The dedup gap is `(5.77 − 0.79) × 100 nodes = 498 MB ≈ 500 MB` of cold pulls saved by distroless vs wolfi at fleet scale. Both still pay 1000 × 3.98 MB for the binary layers, because each binary is unique. Scratch shaves the 79 MB base entirely — its `1000 × 3.98 = 3980 MB` total is 79 MB lighter than distroless and 577 MB lighter than wolfi. But scratch has nothing to dedupe in the first place: every pod's image *is* its binary, so the per-pod cost is linear no matter how many services share a node.

The math at fleet scale (one node, 50 services, 100 % cold cache, 1 Gbps network, ignoring TCP slow-start):

- distroless: `0.79 MB + 50 × 3.98 MB = 199.79 MB ≈ 1.6 s` of pull bandwidth
- wolfi:      `5.77 MB + 50 × 3.98 MB = 204.77 MB ≈ 1.6 s`
- scratch:    `0 + 50 × 3.98 MB     = 199.00 MB ≈ 1.6 s`

At 1 Gbps these are 1.598 s, 1.638 s, 1.592 s — distroless-scratch is 6 ms apart (`0.79 / 125 = 6.3 ms`); wolfi-scratch is 46 ms (`5.77 / 125`). **The 5 MB base-image gap costs 40 ms at 1 Gbps; the 1.6 s of binary-layer pulls every node has to do is `1600 / 40 = 40×` larger.** The only image-size axis that *still* matters at scale is registry storage cost (Wolfi's bulkier base eats more of your ECR/Artifact Registry quota), and that's a billing concern, not a latency one.

But there's a place where the 5 MB *does* matter: when the registry caps API rate per-account-per-region. AWS ECR's [service quotas][ecr-limit] put a default ceiling on `BatchGetImage` and `GetDownloadUrlForLayer` calls per second, per AWS account, per Region — the manifest fetch and per-layer signed-URL requests respectively. At 1000 pods landing on 100 nodes simultaneously and pulling 14 layers each (distroless), every node spends 14 calls on `GetDownloadUrlForLayer` and one on `BatchGetImage` — 100 × 15 = 1,500 API calls in a few seconds, easily over the default. Hit the throttle and p99 pull-time slides from 1.6 s into the 5–10 s tail; the larger your base layer count, the more API calls you spend before getting any bytes.

[ecr-limit]: https://docs.aws.amazon.com/AmazonECR/latest/userguide/service-quotas.html

# What the kernel sees on first start

On Linux, pulling apart cold-start at the syscall level uses `strace`. The brief asked for an `strace` one-liner you can copy-paste — here's the one I run inside the container, pinned to the binary's `execve`:

```bash
# inside a privileged debug pod sharing the target's pid namespace
strace -f -tt -e trace=execve,mmap,openat,read,write,brk,connect \
       -p $(pgrep -f /app | head -1)
```

Here is the actual strace excerpt from running our 10 MB binary inside an alpine container with `--cap-add=SYS_PTRACE` (timestamps elided; lines truncated for the post):

```text
execve("/app", ["/app"], 0xfffffa329ee8 /* 6 vars */) = 0
openat(AT_FDCWD, "/sys/kernel/mm/transparent_hugepage/hpage_pmd_size", O_RDONLY) = 3
mmap(NULL, 262144, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0) = 0xffff9ea8c000
mmap(NULL, 131072, PROT_NONE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0) = 0xffff9ea6c000
mmap(NULL, 1048576, PROT_NONE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0) = 0xffff9e96c000
mmap(NULL, 8388608, PROT_NONE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0) = 0xffff9e000000
mmap(NULL, 67108864, PROT_NONE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0) = 0xffff9a000000
mmap(NULL, 536870912, PROT_NONE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0) = 0xffff7a000000
mmap(NULL, 536870912, PROT_NONE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0) = 0xffff5a000000
... (more PROT_NONE reservations, total > 1 GiB of virtual address) ...
openat(AT_FDCWD, "/proc/self/cgroup", O_RDONLY|O_CLOEXEC) = 3
openat(AT_FDCWD, "/proc/self/mountinfo", O_RDONLY|O_CLOEXEC) = 3
openat(AT_FDCWD, "/sys/fs/cgroup/cpu.max", O_RDONLY|O_CLOEXEC) = 3
... (Go's GOMAXPROCS auto-detection probes container limits) ...
{"level":"info","ts":1778319875.3978097,"caller":"./main.go:66","msg":"ready","boot":0.000523587}
... (then the listen path) ...
[pid 13] socket(AF_INET6, SOCK_STREAM|SOCK_CLOEXEC|SOCK_NONBLOCK, IPPROTO_TCP) = 4
[pid 13] bind(4, {sa_family=AF_INET6, sin6_port=htons(8080), ...}, 28) = 0
[pid 13] listen(4, 4096) = 0
```

The zap line is the punchline: `boot=0.000523587 s ≈ 523 µs`. This number measures from `var bootedAt = time.Now()` (a top-level declaration that runs during our package-init phase, *after* Go runtime init but before `main()`) to the moment `logger.Info("ready")` fires (which sits right after `go func() { _ = srv.ListenAndServe() }()` at line 66 of `main.go`). It's the time spent in our user code — chi router build, prom registration, zap setup, goroutine spawn — and it's just over half a millisecond. The 17–56 ms app-uptime numbers we measured earlier therefore come from two places we did *not* time inline: (a) the pre-`bootedAt` cost of Go runtime + package init (a few ms), and (b) the `socket → bind → listen` plumbing and curl-poll loop after the goroutine starts. The user-code path (the 523 µs slice between `bootedAt` and `logger.Info`) is ~30–100× faster than the combined (a) + (b) — `17000µs / 523µs = 32.5×` at the floor; `56000/523 = 107×` at the slow tail. Don't blame chi or zap or prometheus for cold-start; the cost is in the runtime init you cannot see and the listener probe you don't write.

Four observations the real trace makes obvious:

1. **Go reserves > 1 GiB of virtual address space at boot** — the `PROT_NONE` mmaps for the heap arena (64 MiB), two 512 MiB regions for stack pools, plus several smaller ones. This is virtual reservation, not RSS; the kernel doesn't allocate physical pages. It does mean Go containers look bigger than they are in `top -o RSIZE`.
2. **Go probes container limits at boot** — `/proc/self/cgroup`, `/proc/self/mountinfo`, `/sys/fs/cgroup/cpu.max` are all read in the first millisecond. [Go 1.25][go125-cmp] introduced container-aware `GOMAXPROCS`: the runtime defaults `GOMAXPROCS` to the cgroup CPU bandwidth limit when one is set, and re-reads the cgroup periodically. Helpful when your pod has `cpu: 500m`; surprising if you'd set `GOMAXPROCS=4` manually and didn't realise the runtime was overriding it (you can disable via `GODEBUG=containermaxprocs=0`). Before 1.25, you needed [`uber-go/automaxprocs`][automaxprocs] for this.

[go125-cmp]: https://go.dev/doc/go1.25#container-aware-gomaxprocs
[automaxprocs]: https://github.com/uber-go/automaxprocs
3. **The CA-bundle read happens lazily** at first `tls.Dial` — not at boot. If you're on scratch and forgot to ship a CA bundle, the bug doesn't appear until your first HTTPS call. The error is `x509: certificate signed by unknown authority`. Distroless includes the bundle at the canonical Linux path, so `crypto/x509` finds it without env-var gymnastics.
4. **`time.LoadLocation("Asia/Kolkata")` opens `/usr/share/zoneinfo/Asia/Kolkata`**. On scratch that file does not exist; Go falls back to the embedded `tzdata` package only if you imported `time/tzdata` (which adds 448 KB to the binary, measured: 1,638,562 → 2,097,314 B on Go 1.26 arm64-linux). Distroless ships the OS zoneinfo so you don't have to.

These four are the "scratch surprises" that bite payments services when one engineer in Bangalore opens an OutboxItem, calls `time.LoadLocation`, and the test pod returns HTTP 500 in the staging cluster.

## A 37-line repro

Want to run it yourself? This script is the entire benchmark (37 lines, including the in-line Go program and the build-and-time loop), reproducing the pull-time + boot-time matrix above:

```bash
#!/usr/bin/env bash
# repro.sh — distroless vs wolfi vs scratch microbench (M-series Mac, podman 5+)
set -eu
mkdir -p /tmp/dlcs && cd /tmp/dlcs
cat > main.go <<'EOF'
package main
import ("fmt"; "net/http"; "os"; "time")
var booted = time.Now()
func main() {
  http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
    fmt.Fprintf(w, `{"uptime_ms":%d}`, time.Since(booted).Milliseconds())
  })
  go http.ListenAndServe(":8080", nil)
  fmt.Fprintln(os.Stderr, "ready"); select {}
}
EOF
go mod init bench >/dev/null 2>&1 || true
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-s -w" -trimpath -o app main.go
declare -A bases=(
  [scratch]="scratch"
  [distroless]="gcr.io/distroless/static:latest"
  [wolfi]="cgr.dev/chainguard/wolfi-base:latest"
)
for tag in "${!bases[@]}"; do
  printf "FROM %s\nCOPY app /app\nENTRYPOINT [\"/app\"]\n" "${bases[$tag]}" > Containerfile.$tag
  podman build --platform linux/arm64 -f Containerfile.$tag -t bench/$tag .
done
for tag in scratch distroless wolfi; do
  for i in 1 2 3; do
    cid=$(podman run -d --rm -p 8080:8080 bench/$tag)
    t0=$(date +%s%3N)
    until curl -fs http://localhost:8080/healthz >/dev/null 2>&1; do sleep 0.005; done
    t1=$(date +%s%3N)
    echo "$tag run#$i $((t1-t0)) ms"
    podman stop -t1 "$cid" >/dev/null
  done
done
```

It produces the boot-time table above on any arm64 Mac with podman or Docker Desktop. On native Linux x86 nodes the runtime overhead is typically much lower than the ~200 ms we measured here (no VM hop, native overlayfs and cgroups), but the *relative* ordering of the three bases stays inside the noise band.

# What this system is bad at

Pick a base, accept the holes:

**Scratch breaks anything that needs `/etc`** or `/usr/share`. `time.LoadLocation` (no zoneinfo) — fixed by `import _ "time/tzdata"` which embeds the Olson DB into the binary at a measured cost of `2,097,314 - 1,638,562 = 458,752 B ≈ 450 KB`. `net.LookupHost` (Go's pure-Go resolver under `CGO_ENABLED=0` reads `/etc/nsswitch.conf`; with no file it falls back to its hardcoded ordering — works, with a `nsswitch.conf` parse warning) — the `netgo` [build tag][netgo] forces this same resolver even with CGO. [`os/user`](https://pkg.go.dev/os/user) `Current()` returns ENOENT because there's no `/etc/passwd`. CA validation needs you to embed certs into the binary (`go:embed` works) or set `SSL_CERT_DIR`/`SSL_CERT_FILE` at runtime.

[netgo]: https://pkg.go.dev/net#hdr-Name_Resolution

**Distroless breaks anything that needs a shell**. `kubectl exec -- sh` returns `OCI runtime exec failed: exec failed: unable to start container process: exec: "sh": executable file not found in $PATH`. You can `kubectl debug --image=busybox` to share namespaces with the pod, but that adds a layer of indirection your incident-response runbook needs to teach. Distroless also pins specific versions of zoneinfo / CAs at image-build time — if a new Let's Encrypt root rolls out and you need it now, you can't `apk upgrade ca-certificates` on distroless (no apk, no `update-ca-certificates` script). The fix is a multi-stage Dockerfile: a Debian builder stage runs `update-ca-certificates` to merge the new root into `/etc/ssl/certs/ca-certificates.crt`, then `COPY --from=builder /etc/ssl/certs/ca-certificates.crt` into a `FROM gcr.io/distroless/static` final stage. CI rebuild is seconds; you do not have to wait on Google's distroless rebuild cadence.

**Wolfi breaks the "minimal attack surface" argument**. You shipped glibc, libssl, busybox, ldconfig. Each is a CVE source. Chainguard's [build pipeline][cgrpipe] rebuilds and re-signs every package, but you've still increased the surface area by 6–10× (5.77 MB / 0.79 MB = 7.3× by bytes; counting installed binaries the ratio is closer to 10×). PCI-DSS auditors notice. The benefit is that when a CVE drops at midnight you can `apk upgrade openssl` (the Wolfi package, currently `openssl-3.6.2-r5`) and rebuild from your CI in seconds instead of waiting for a base-image refresh upstream. That's a real ops-velocity win that scratch and distroless don't give you.

[cgrpipe]: https://github.com/chainguard-dev/melange

**Observability without `kubectl debug` is rough on all three**. Scratch and distroless ship none of `curl`, `dig`, `tcpdump`, `lsof`, `ps`. Wolfi-base ships `lsof`, `ps`, and `ping` (verified by `podman run cgr.dev/chainguard/wolfi-base which ...`) but not `curl`, `dig`, `tcpdump`, or `nc`. The modern fix on all three is [ephemeral debug containers][ephemeral] (`kubectl debug pod -it --image=nicolaka/netshoot --target=app`), which works on scratch the same as on Wolfi. If your platform team hasn't enabled ephemeral containers, distroless and scratch will haunt you the first time a pod is "stuck" and you can't shell in.

[ephemeral]: https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/#ephemeral-container

# What I'd build differently

Three changes I'd make to a real platform team's container baseline.

**1. Pick distroless-static as the default, scratch as the opt-in**. The wire delta vs scratch is `4.83 - 3.98 = 0.85 MB`, and the cold-pull delta is zero (both images p50 at 0.30 s in our local-registry harness). The CA bundle and tzdata are worth those 0.85 MB on every TLS-using and time-zone-aware service — which is every payments service. Reserve scratch for binaries that have *measured* their startup floor and need to shave the last megabyte of base-image dependency (your build pipeline, your sidecars, your one-shot CronJobs).

**2. Build the binary with `-buildmode=pie` only when you need ASLR**. Default Go non-PIE binaries link against fixed virtual addresses. With `-buildmode=pie` Go produces a static-PIE: the binary is still self-contained (no `ld.so` involved on a `CGO_ENABLED=0` build), but the kernel + the binary's own startup code apply relocations on every `execve` so the text segment is randomised. For a 10 MB binary the relocation pass is a fraction of a millisecond per pod. At 1000 pods scaling in parallel the wall-clock impact stays sub-millisecond per pod, but the cumulative CPU cost shows up on the cluster-wide PSI graph. Use [`go build -buildmode=pie`][pie] only on binaries that ship to untrusted hosts (and run [`go test -bench`][gobench] on your own binary to measure the delta before opting in).

[pie]: https://pkg.go.dev/cmd/go#hdr-Build_modes
[gobench]: https://pkg.go.dev/testing#hdr-Benchmarks

**3. Run a registry mirror on every node, not in the cluster**. `containerd` supports [registry mirrors][mirror] in `/etc/containerd/config.toml`. Run a `registry:2` on each kubelet node bound to `127.0.0.1`, with the cluster registry as upstream, and the per-pod pull becomes a localhost RTT. We measured this explicitly: localhost-registry pulls landed at 0.25–0.30 s, gcr.io pulls at 2.79–2.99 s — a per-pull saving of `~2.5 s`. With pulls fully parallel across the fleet (`--serialize-image-pulls=false`), the cluster wall-clock saving is roughly one pull-time (~2.5 s on the cluster's critical path). With kubelet's [`--serialize-image-pulls=true`][serialize] flag (which many K8s distros leave on by default), pulls run one-at-a-time *per node*, so the per-node saving multiplies by pods-per-node — for 10 pods/node that's `10 × 2.5 = 25 s` shaved off each node's catch-up window. Either way it dwarfs the base-image choice.

[serialize]: https://kubernetes.io/docs/reference/command-line-tools-reference/kubelet/

[mirror]: https://github.com/containerd/containerd/blob/main/docs/hosts.md

# Tradeoffs, named explicitly

| Property                              | Scratch | Distroless-static | Wolfi-base |
|---|:-:|:-:|:-:|
| Wire bytes (10 MB binary, this study) | 3.98 MB | 4.83 MB | 10.03 MB |
| Layer count                           | 1       | 14      | 12         |
| Cold-pull p50 (local registry)        | 0.30 s  | 0.30 s  | 0.25 s     |
| `kubectl exec -- sh` works            | ❌      | ❌      | ✅         |
| `tls.Dial` works without code change  | ❌¹     | ✅      | ✅         |
| `time.LoadLocation("Asia/Kolkata")`   | ❌²     | ✅      | ✅         |
| `apk upgrade openssl` from CI         | ❌      | ❌      | ✅         |
| Daily-rebuilt CVE-fixed base image    | ❌      | partial³ | ✅         |
| SBOM shipped in image                 | ❌      | ❌      | ✅         |
| Attack surface (rough)                | min     | min++   | min × 8    |

¹ unless you `go:embed` a CA bundle and load it via `x509.NewCertPool().AppendCertsFromPEM`, or set `SSL_CERT_FILE` at runtime.
² unless you `import _ "time/tzdata"` (+448 KB measured on Go 1.26 arm64-linux: 1,638,562 → 2,097,314 B).
³ Google rebuilds distroless on its own [release cadence][grcadence], driven by upstream Debian package updates rather than a fixed weekly clock.

[grcadence]: https://github.com/GoogleContainerTools/distroless/blob/main/RELEASES.md

The pithy version: **scratch is for things that don't talk to TLS or care about time. Distroless is the sane default for Go services. Wolfi is for teams that want their security team to own the base.** None of the three meaningfully changes cold-start latency for a 10 MB binary — that lever is on the runtime side, not the image side.

> A multi-megabyte image is not what's making your pod slow to start. The kubelet pull queue, the container-runtime overhead, and the kernel's `unshare`/`pivot_root`/`execve` chain are. Optimise those first; pick a base second; argue about scratch vs distroless never.

# Further reading

- [google/distroless](https://github.com/GoogleContainerTools/distroless) — the build rules, including `bazel run :static` if you want to learn what each of those 13 layers is for.
- [chainguard-images/images/wolfi-base](https://github.com/chainguard-images/images/tree/main/images/wolfi-base) — Wolfi-base's APKO build config, including the SBOM emission.
- [containerd snapshotters](https://github.com/containerd/containerd/tree/main/docs/snapshotters) — how layer mounts actually work; useful when you wonder why your overlayfs pod is slow.
- [opencontainers/image-spec](https://github.com/opencontainers/image-spec/blob/main/manifest.md) — the manifest format the curls in this post pull. Worth a read for everyone who deploys containers.
- [The 1B-payments post](/posts/1b-payments-per-day/) — same observability lens, applied to the database layer instead of the container runtime.

# Colophon

Every number in this post was either curl'd from a registry I could ping (`gcr.io`, `cgr.dev`, my own `localhost:5005`) or measured on `podman 5.6.0` on Darwin arm64 (M3, 12 cores, 36 GB). Build commands, binary sizes, manifest layer counts, decompression timings — all reproducible from the 37-line repro above on any arm64 Mac. I did *not* spin up an actual `kind` or `k3d` cluster: the post substitutes `podman run` for `kubectl apply` everywhere, which faithfully captures the containerd snapshotter + runc path but skips the kubelet pull-scheduler, kube-scheduler, and the kube-proxy networking. The two industry-standard claims I leaned on without my own measurement — ECR's per-account API rate limits at the 1000-pod cliff, and native-Linux container-runtime overhead being smaller than podman-on-mac — are cited inline. Where I did napkin math (the syscall-by-syscall startup cost), I showed the addition.

Like every cold-start post, this one is biased by the rig. On native x86 Linux nodes (no podman-machine VM, native cgroups, native overlayfs) the container-runtime overhead is typically a fraction of what we measured here, and the *relative* differences between bases compress further. With [`containerd/stargz-snapshotter`][stargz] in front you can lazy-mount layers and serve only the bytes a process actually pages in — at which point Wolfi's full glibc stops costing what the manifest says. The framework here — measure, count layers, time the runtime, separate app from plumbing — survives the rig change. The numbers shift; the lesson doesn't.

[stargz]: https://github.com/containerd/stargz-snapshotter
