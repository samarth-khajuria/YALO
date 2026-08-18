FROM nginx:alpine

# nginx site config (replaces the default server block).
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Static pages.
COPY html/ /usr/share/nginx/html/

# Runtime-config entrypoint: writes config.js from CONTROL_PLANE_URL, then nginx.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80

ENTRYPOINT ["/entrypoint.sh"]
