# Egress allow-list proxy: only whitelisted domains may leave the sandbox network.
# Everything else is denied (FilterDefaultDeny). See sibling filter + tinyproxy.conf.
FROM alpine:3.20
RUN apk add --no-cache tinyproxy
COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY filter /etc/tinyproxy/filter
EXPOSE 8888
CMD ["tinyproxy","-d","-c","/etc/tinyproxy/tinyproxy.conf"]
