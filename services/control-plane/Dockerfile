FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

# Run as a non-root user.
RUN useradd --create-home --uid 10001 appuser
USER appuser

ENV PORT=8000
EXPOSE ${PORT}

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen(f\"http://localhost:{os.getenv('PORT','8000')}/health\")" || exit 1

CMD ["python", "-m", "app.main"]
