# The decoder image this repo publishes as ghcr.io/arkiv-network/arkiv-chain-indexer/decoder,
# under the same release tag as the app and frontend images so a deployment pins all three at once.
#
# It is the released arkiv-transaction-decoder image re-published with the port Arkiv deployments
# expect. Upstream defaults PORT to 3000, being a standalone service; 28884 is this repo's
# convention, and the db-chain chart both TCP-probes 28884 and points DECODER_URL at it without
# passing PORT — so the port has to come from the image. atlas-transaction-decoder, which this
# replaced, listened on 28884 by default; taking that default away is what left the v0.3.2 decoder
# bound to 3000 with nothing on 28884, failing its startup probe into Init:CrashLoopBackOff.
#
# Pinned by digest to the tag docker-compose.yml runs (v0.2.0), so what a deployment runs is what
# this repo is tested against. Move both together.
FROM ghcr.io/arkiv-network/arkiv-transaction-decoder@sha256:e5490e32fe155ff9c0a63fbf3857c60d78d84c1172b9d1748c3f53bc12cad198

ENV PORT=28884
EXPOSE 28884
