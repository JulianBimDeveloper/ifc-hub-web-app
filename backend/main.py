"""Punto de entrada del backend IFC Hub v2 (FastAPI).

Configura logging y CORS desde `core.config.settings` y monta los routers.
"""

from core.config import settings
from core.logging_config import setup_logging

setup_logging()

import mimetypes
import os

# El registro de mimetypes de Windows no siempre conoce ".mjs" y StaticFiles
# cae a "text/plain" -> los navegadores rechazan un <script type="module">
# servido así ("Failed to load module script... non-JavaScript MIME type").
# Necesario para servir el worker de @thatopen/fragments desde /viewer-static.
mimetypes.add_type("text/javascript", ".mjs")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from routers import health, viewer, ifc
from routers import client_review
from routers import peb
from routers import hub

app = FastAPI(title="IFC Hub v2 — Backend", version="2.0.0")

app.add_middleware(GZipMiddleware, minimum_size=1000)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Assets del visor (Vite build de viewer-next/, That Open Platform). El HTML
# en sí lo sirve /api/viewer-html (routers/viewer.py) como FileResponse; aquí
# solo se montan los JS/worker que ese HTML referencia con base "/viewer-static/".
_VIEWER_DIST = os.path.join(os.path.dirname(__file__), "..", "viewer-next", "dist")
if os.path.isdir(_VIEWER_DIST):
    app.mount("/viewer-static", StaticFiles(directory=_VIEWER_DIST), name="viewer-static")


@app.middleware("http")
async def _viewer_static_no_cache(request, call_next):
    # Los JS fingerprinted (index-<hash>.js) podrían cachearse libremente,
    # pero thatopen-worker.min.mjs (copiado de public/, sin hash) NO debe
    # quedar cacheado indefinidamente bajo la misma URL -- revalidar siempre.
    response = await call_next(request)
    if request.url.path.startswith("/viewer-static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response

app.include_router(health.router)
app.include_router(viewer.router, prefix="/api")
app.include_router(ifc.router, prefix="/api/ifc")
app.include_router(client_review.router, prefix="/api/ifc/client-review")
app.include_router(peb.router, prefix="/api")
app.include_router(hub.router, prefix="/api")
