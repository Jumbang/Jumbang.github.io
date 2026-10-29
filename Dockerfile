FROM python:3.12-slim
WORKDIR /app
COPY server.py ./
COPY static ./static
ENV PORT=8000 DB_PATH=/data/suite.db
VOLUME ["/data"]
EXPOSE 8000
CMD ["python3", "server.py"]
