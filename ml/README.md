# Clasificación forestal vs. urbano/agrícola — pipeline de investigación

Dos clasificadores independientes, evaluados con métricas reales antes de
decidir cuál (o si ambos) integrar a la app. Nada de esto se ejecutó
todavía en un entorno con acceso a internet real — corre y depura esto en
tu propia máquina, no en el sandbox donde se escribió.

## Los dos niveles

**Nivel 1 — `worldcover_classifier.py`**: consulta un pixel de ESA
WorldCover (mapa global ya clasificado por un modelo de última
generación, 10m de resolución). Rápido, sin auth, bajo riesgo. Recomendado
como punto de partida.

**Nivel 2 — `multispectral_classifier.py`**: baja una imagen Sentinel-2
real del punto, corre un ResNet18 preentrenado (SSL4EO-S12, aprendizaje
auto-supervisado sobre millones de escenas) para extraer un embedding, y
clasifica con una regresión logística ajustada sobre el benchmark EuroSAT
(ajuste que toma segundos, no horas — el modelo profundo en sí queda
congelado, nunca se reentrena). Esto es lo que pediste literalmente:
analiza bandas reales, no un mapa precalculado.

## Instalación

```bash
cd ml
python -m venv venv
venv\Scripts\activate        # Windows
pip install -r requirements.txt
```

Si solo quieres probar Nivel 1 primero (más rápido de instalar), comenta
las líneas de `torch`/`torchgeo`/`scikit-learn`/`pystac-client` en
`requirements.txt` antes de instalar.

## Paso 1 — Descargar una muestra real de FIRMS con etiquetas de NASA

```bash
python download_firms_sample.py TU_FIRMS_MAP_KEY --days 3
```

Esto trae detecciones de 5 regiones mixtas (para no sesgar la muestra
hacia solo bosque o solo industria) y filtra las que traen el campo
`type` de NASA (0=vegetación, 1=volcán, 2=fuente estática/industrial,
3=costa afuera) — esa es la única verdad base independiente disponible
sin etiquetar nada a mano. Es un campo disperso (la mayoría de las
detecciones no lo traen), así que si `evaluate.py` te dice "0 puntos
etiquetados", sube `--days` a 7 o 10.

## Paso 2 — Probar un clasificador suelto (opcional, sanity check rápido)

```bash
python worldcover_classifier.py
python multispectral_classifier.py   # tarda más la primera vez (baja EuroSAT)
```

## Paso 3 — Evaluar con métricas

```bash
python evaluate.py firms_sample.csv --classifier worldcover
python evaluate.py firms_sample.csv --classifier multispectral
python evaluate.py firms_sample.csv --classifier both
```

Te da accuracy, precisión/recall/F1 por clase, y matriz de confusión para
cada uno, más una comparación directa al final si corres `--classifier both`.

## Cómo leer los resultados con ojo crítico

- El campo `type` de NASA es una señal real pero incompleta — no es una
  verdad base validada a mano. Un accuracy del 85% no significa
  "85% de las veces acertamos la realidad", significa "85% de las veces
  coincidimos con lo que NASA ya había marcado, cuando lo marcó".
- Si el Nivel 2 (multiespectral) no supera claramente al Nivel 1
  (WorldCover) en las métricas, no vale la pena la complejidad y el
  riesgo extra de integrarlo a producción — quédate con WorldCover.
- Presta atención a la matriz de confusión, no solo al accuracy total: si
  la muestra viene muy desbalanceada (por ejemplo 90% forestal), un
  accuracy alto puede estar escondiendo que el clasificador nunca acierta
  "urbano" — por eso `evaluate.py` también reporta F1 macro (promedia por
  clase, no por punto), que no se deja engañar por ese desbalance.

## Antes de integrar a producción

Recuerda la restricción de "casi tiempo real, sin frenar el sistema": el
que elijas debe correr dentro de `fetch_firms.py` (batch horario de
GitHub Actions), nunca en el navegador del usuario. WorldCover es trivial
de meter ahí (una consulta HTTP por punto, cacheable). El clasificador
multiespectral es más pesado — si lo eliges, vale la pena cachear
agresivamente por coordenada redondeada (ya implementado en ambos
clasificadores) para no re-bajar imagen ni re-correr el modelo en cada
corrida horaria para el mismo punto geográfico.
