#!/bin/bash
# 片段HUB SnippetHub —— TOS 7 侧载预览（**只给开发调试用**）
#
# 背景：TOS 的 iframe 页面路由（/<appid>/）和鉴权配置是平台在
# **应用中心安装** 时生成的。用 dpkg -i 手工侧载时平台不会认这个应用，
# 页面会 404。这个脚本临时往 nginx 里挂一条路由，让你能直接在浏览器
# 里打开页面调试；正式发布请把 deb 提交到开发者平台，从应用中心安装。
#
# 用法（在 NAS 上执行，需要 root）：
#   ./preview.sh on     挂上预览路由
#   ./preview.sh off    摘掉预览路由
#   ./preview.sh status 看当前状态
#
# 注意：预览路由**没有平台鉴权**，只有应用自己的访问密码。
# 只在内网调试时开，调试完记得 off。
set -euo pipefail

APPID="snippethub"
APP="/usr/local/${APPID}"
CONF="/etc/nginx/conf.d/zz-${APPID}-preview.conf"
SOCK="/var/api/${APPID}.sock"

case "${1:-status}" in
  on)
    if [ ! -d "${APP}/webui" ]; then
      echo "错误：${APP}/webui 不存在，先装 deb 或手动解压 webui.bz2" >&2
      exit 1
    fi
    cat > "${CONF}" <<EOF
# 片段HUB 侧载预览（由 preview.sh 生成，正式安装后请删除本文件）
location /${APPID}/ {
    alias ${APP}/webui/;
    index index.html;
    try_files \$uri \$uri/ /${APPID}/index.html;
}
location ^~ /v2/proxy/${APPID}/ {
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    client_max_body_size 512m;
    proxy_read_timeout 300s;
    proxy_pass http://unix:${SOCK}:/;
}
EOF
    nginx -t >/dev/null 2>&1 || { echo "nginx 配置有误，已回滚" >&2; rm -f "${CONF}"; exit 1; }
    nginx -s reload 2>/dev/null || true
    # reload 是异步的：老 worker 收尾前请求还可能落到旧配置上，这里等一下再报结果
    code="000"
    for _ in $(seq 1 20); do
      code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8181/${APPID}/" 2>/dev/null || echo 000)
      [ "${code}" = "200" ] && break
      sleep 0.3
    done
    if [ "${code}" = "200" ]; then
      echo "预览已开启：http://<NAS地址>:8181/${APPID}/"
    else
      echo "预览配置已写入，但页面返回 ${code}，检查 /usr/local/${APPID}/webui 是否存在、服务是否在跑" >&2
    fi
    ;;
  off)
    rm -f "${CONF}"
    nginx -s reload 2>/dev/null || true
    # 同样等 reload 生效，确认页面已经回到 404 再报「已移除」
    for _ in $(seq 1 20); do
      code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8181/${APPID}/" 2>/dev/null || echo 000)
      [ "${code}" != "200" ] && break
      sleep 0.3
    done
    echo "预览路由已移除"
    ;;
  status)
    if [ -f "${CONF}" ]; then
      echo "预览路由：已开启（${CONF}）"
      curl -s -o /dev/null -w "页面状态码 %{http_code}\n" "http://127.0.0.1:8181/${APPID}/" || true
    else
      echo "预览路由：未开启"
    fi
    echo -n "服务状态："
    systemctl is-active "${APPID}.service" 2>/dev/null || true
    ;;
  *)
    echo "用法: $0 {on|off|status}" >&2
    exit 1
    ;;
esac
