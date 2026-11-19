FROM python:3.11-slim

# 需要 OpenCascade 时：docker build --build-arg WITH_OCP=1 -t stru-python-sandbox:latest server/ai/python
ARG WITH_OCP=0

# pip 失败必须让构建失败；useradd 因用户可能已存在才单独容忍（用括号限定 || true 的作用域）。
# 注意：不要把 useradd ... || true 直接接在 pip 的 && 链尾，否则 shell 会把整条链的成功条件
# 退化成 || true，pip 装失败也会被吞掉，产出一个没有依赖的“空”镜像。
RUN pip install --no-cache-dir numpy==2.2.6 Pillow==11.3.0 scipy==1.15.3 \
    && if [ "$WITH_OCP" = "1" ]; then pip install --no-cache-dir cadquery-ocp cadquery; fi \
    && (useradd --create-home --shell /usr/sbin/nologin sandbox 2>/dev/null || true) \
    && mkdir -p /tmp && chmod 1777 /tmp

# bootstrap.py 直接 COPY 进镜像，容器启动时从镜像内执行，不依赖宿主机文件挂载。
# 这样在 Windows Docker Desktop 上无需配置 File Sharing（改安全策略时需重建镜像）。
# 放在 pip 层之后：改 bootstrap 只重建这一层，依赖层继续命中缓存。
COPY bootstrap.py /sandbox/bootstrap.py

# WORKDIR 用 /tmp（只读根文件系统下唯一可写处）；bootstrap.py 已在镜像 /sandbox 中。
WORKDIR /tmp
USER 65534:65534
