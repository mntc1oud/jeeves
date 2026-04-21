FROM debian:trixie-slim

RUN useradd -m plushkin
WORKDIR /home/plushkin

ADD ./firefox/install .
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
--mount=type=cache,target=/var/lib/apt,sharing=locked \
  apt update && apt-get -qqy install libavcodec-extra libasound2 \
    libgtk-3-dev libdbus-glib-1-dev \
    xz-utils wget gzip caddy
RUN ./install

RUN wget https://github.com/cloudflare/workerd/releases/download/v1.20260317.1/workerd-linux-64.gz
RUN gunzip workerd-linux-64.gz && chmod +x ./workerd-linux-64

COPY workerd/config.capnp .
COPY --from=dist plushkin/index.js .

ADD run .
USER plushkin

EXPOSE 9222

CMD ["/bin/bash", "./run"]
