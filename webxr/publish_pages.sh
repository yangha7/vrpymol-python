#!/bin/sh
# Publish the baked static site (_site/, from `python -m webxr.bake_static`)
# to the gh-pages branch, which GitHub Pages serves.
#
# The branch holds a single commit that is replaced on every publish: the
# baked .glb files are hundreds of MB and fully regenerable, so keeping their
# history would only bloat the repo.
set -e
cd "$(dirname "$0")/.."
test -f _site/baked/manifest.json || { echo "no _site/ -- run: python -m webxr.bake_static" >&2; exit 1; }

source_rev=$(git rev-parse --short HEAD)
# Same author as the source commit, so this works without a global git identity.
export GIT_AUTHOR_NAME="$(git log -1 --format=%an)" GIT_AUTHOR_EMAIL="$(git log -1 --format=%ae)"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
remote=$(git remote get-url origin)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cp -R _site/. "$tmp"
cd "$tmp"
git init -q
git checkout -q -b gh-pages
git add -A
git commit -q -m "Static site baked from $source_rev"
# The site is several hundred MB in one commit. git's default 1 MB HTTP
# buffer makes it stream that as a chunked upload, which GitHub tends to
# drop partway ("RPC failed ... the remote end hung up"); a buffer larger
# than the pack sends it as one ordinary request instead.
git -c http.postBuffer=1048576000 -c http.version=HTTP/1.1 push -f "$remote" gh-pages
