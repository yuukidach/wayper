"""Focused building blocks for the local preference model.

The historical :mod:`wayper.preference_model` facade remains available for
ledger and CLI operations; this package exposes the data/model primitives for
new integrations without importing that orchestration layer.
"""

from .model import (
    FeatureSpace,
    PreferenceExample,
    PreferenceModel,
    PreferencePrediction,
    PreferenceTrainingSnapshot,
)
from .training import train_preference_model

__all__ = [
    "FeatureSpace",
    "PreferenceExample",
    "PreferenceModel",
    "PreferencePrediction",
    "PreferenceTrainingSnapshot",
    "train_preference_model",
]
