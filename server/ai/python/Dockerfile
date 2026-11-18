FROM python:3.11-slim

# AI Python 工具的硬隔离镜像。构建：
#   docker build -t stru-python-sandbox:latest server/ai/python
# 需要 OpenCascade 时：docker build --build-arg WITH_OCP=1 -t stru-python-sandbox:latest server/ai/python
ARG WITH_OCP=0

RUN pip install --no-cache-dir numpy==2.2.6 Pillow==11.3.0 scipy==1.15.3 \
    && if [ "$WITH_OCP" = "1" ]; then pip install --no-cache-dir cadquery-ocp cadquery; fi \
    && useradd --create-home --shell /usr/sbin/nologin sandbox 2>/dev/null || true \
    && mkdir -p /tmp && chmod 1777 /tmp

# bootstrap.py 由 docker run 以只读卷挂载到 /sandbox，不复制进镜像，
# 这样改安全策略不必重建镜像。
WORKDIR /tmp
USER 65534:65534
