FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app
COPY app.py hub.html plex.html fridge.html ./
COPY icons/fridge.png icons/plex.png ./icons/

EXPOSE 8080
CMD ["python", "app.py"]
