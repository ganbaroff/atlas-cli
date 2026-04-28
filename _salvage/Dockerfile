FROM docker.io/library/node:20-slim

ARG SANDBOX_NAME="anus-cli-sandbox"
ARG CLI_VERSION_ARG
ENV SANDBOX="$SANDBOX_NAME"
ENV CLI_VERSION=$CLI_VERSION_ARG

# install minimal set of packages, then clean up
RUN apt-get update && apt-get install -y --no-install-recommends \
  python3 \
  make \
  g++ \
  man-db \
  curl \
  dnsutils \
  less \
  jq \
  bc \
  gh \
  git \
  unzip \
  rsync \
  ripgrep \
  procps \
  psmisc \
  lsof \
  socat \
  ca-certificates \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# set up npm global package folder under /usr/local/share
# give it to non-root user node, already set up in base image
RUN mkdir -p /usr/local/share/npm-global \
  && chown -R node:node /usr/local/share/npm-global
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

# switch to non-root user node
USER node

# install anus-cli and clean up
COPY packages/cli/dist/anus-dev-cli-*.tgz /usr/local/share/npm-global/anus-cli.tgz
COPY packages/core/dist/anus-dev-cli-core-*.tgz /usr/local/share/npm-global/anus-core.tgz
RUN npm install -g /usr/local/share/npm-global/anus-cli.tgz /usr/local/share/npm-global/anus-core.tgz \
  && npm cache clean --force \
  && rm -f /usr/local/share/npm-global/anus-{cli,core}.tgz

# default entrypoint when none specified
CMD ["anus"]
