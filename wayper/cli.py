"""CLI entry point."""

from __future__ import annotations

import asyncio
import json as json_mod
import sys
from pathlib import Path

import click

from .backend import notify
from .config import load_config
from .core import do_ban, do_fav, do_next, do_prev, do_unban, do_unfav
from .pool import favorite_filenames, should_download
from .state import ALL_PURITIES, read_mode, toggle_base, toggle_purity, write_mode
from .status import status_snapshot


def _require_success(result, use_json: bool) -> None:
    """Render a consistent machine-/human-readable core error and stop."""
    if result.ok:
        return
    if use_json:
        click.echo(json_mod.dumps({"error": result.error}))
    else:
        click.echo(result.error, err=True)
    raise SystemExit(1)


@click.group()
@click.option("--json", "use_json", is_flag=True, help="Output in JSON format.")
@click.option("--config", "config_path", type=click.Path(exists=True), default=None)
@click.pass_context
def cli(ctx, use_json, config_path):
    """Wayper - Wayland wallpaper manager."""
    from .logging import setup_logging

    setup_logging()
    ctx.ensure_object(dict)
    ctx.obj["config"] = load_config(Path(config_path) if config_path else None)
    ctx.obj["json"] = use_json


@cli.group(invoke_without_command=True)
@click.pass_context
def daemon(ctx):
    """Run the wallpaper daemon (download loop + rotation).

    Bare 'wayper daemon' runs in foreground.
    'wayper daemon start' runs in background.
    'wayper daemon stop' stops the background daemon.
    """
    if ctx.invoked_subcommand is None:
        config = ctx.obj["config"]
        from .logging import setup_logging

        setup_logging()
        from .daemon import run_daemon

        asyncio.run(run_daemon(config))


@daemon.command()
@click.pass_context
def start(ctx):
    """Start the daemon in the background."""
    config = ctx.obj["config"]
    from .daemon import is_daemon_running

    running, pid = is_daemon_running(config)
    if running:
        click.echo(f"Daemon already running (PID {pid})")
        return

    if config.pid_file.exists():
        try:
            config.pid_file.unlink()
            click.echo("Removed stale PID file.")
        except OSError as e:
            click.echo(f"Warning: Could not remove stale PID file: {e}", err=True)

    from .daemon import start_daemon_process

    start_daemon_process()
    click.echo("Daemon started in background.")


@daemon.command()
@click.pass_context
def stop(ctx):
    """Stop the background daemon."""
    config = ctx.obj["config"]
    from .daemon import is_daemon_running

    running, pid = is_daemon_running(config)
    if not running:
        click.echo("Daemon is not running")
        return

    if pid:
        try:
            from .daemon import request_stop

            if request_stop(config):
                click.echo(f"Stopped daemon (PID {pid})")
            else:
                click.echo("Could not signal daemon", err=True)
                raise SystemExit(1)
        except ProcessLookupError:
            click.echo("Daemon process not found (stale PID file?)")
            # Cleanup stale pid file?
            # The next run will overwrite it, or is_daemon_running handles it.
            # remove_pid_file is in daemon.py, not easily accessible here without import.
            pass


@cli.command("next")
@click.pass_context
def next_cmd(ctx):
    """Change wallpaper on the focused monitor."""
    config = ctx.obj["config"]
    use_json = ctx.obj["json"]

    result = do_next(config)
    _require_success(result, use_json)

    if use_json:
        data = {"action": "next", "monitor": result.monitor, "image": str(result.image)}
        click.echo(json_mod.dumps(data))
    else:
        notify("Wallpaper", "Next wallpaper")

    # Trigger download with same probability as daemon
    purities = read_mode(config)
    download_map = should_download(config, purities)
    to_download = [p for p, needs in download_map.items() if needs]
    if to_download:
        from .wallhaven import WallhavenClient

        async def _download():
            client = WallhavenClient(config)
            try:
                tasks = []
                for purity in to_download:
                    tasks.append(client.download_for("landscape", purity))
                    tasks.append(client.download_for("portrait", purity))
                await asyncio.gather(*tasks)
            finally:
                await client.close()

        asyncio.run(_download())


@cli.command("prev")
@click.pass_context
def prev_cmd(ctx):
    """Go back to the previous wallpaper."""
    config = ctx.obj["config"]
    use_json = ctx.obj["json"]

    result = do_prev(config)
    _require_success(result, use_json)

    if result.status == "at_oldest":
        if use_json:
            click.echo(json_mod.dumps({"action": "prev", "status": "at_oldest"}))
        else:
            notify("Wallpaper", "Already at oldest")
    else:
        if use_json:
            click.echo(
                json_mod.dumps(
                    {"action": "prev", "monitor": result.monitor, "image": str(result.image)}
                )
            )
        else:
            notify("Wallpaper", "Previous wallpaper")


@cli.command()
@click.option("--open", "open_url", is_flag=True, help="Open on Wallhaven.")
@click.pass_context
def fav(ctx, open_url):
    """Favorite the current wallpaper."""
    config = ctx.obj["config"]
    use_json = ctx.obj["json"]

    result = do_fav(config, open_url=open_url)
    _require_success(result, use_json)

    if result.status == "already_favorite":
        if use_json:
            click.echo(json_mod.dumps({"action": "fav", "status": "already_favorite"}))
        else:
            notify("Wallpaper", "Already in favorites")
        return

    if use_json:
        click.echo(
            json_mod.dumps({"action": "fav", "image": str(result.image), "opened": open_url})
        )
    else:
        msg = "Saved & opened on Wallhaven" if open_url else "Saved to favorites"
        notify("Wallpaper", msg)


@cli.command()
@click.pass_context
def unfav(ctx):
    """Remove current wallpaper from favorites."""
    config = ctx.obj["config"]
    use_json = ctx.obj["json"]

    result = do_unfav(config)
    _require_success(result, use_json)

    if result.status == "not_favorite":
        if use_json:
            click.echo(json_mod.dumps({"action": "unfav", "status": "not_favorite"}))
        else:
            notify("Wallpaper", "Not a favorite")
        return

    if use_json:
        click.echo(json_mod.dumps({"action": "unfav", "image": str(result.image)}))
    else:
        notify("Wallpaper", "Removed from favorites")


@cli.command()
@click.pass_context
def ban(ctx):
    """Blacklist current wallpaper and switch to a new one."""
    config = ctx.obj["config"]
    use_json = ctx.obj["json"]

    result = do_ban(config)
    _require_success(result, use_json)

    if result.status == "is_favorite":
        if use_json:
            click.echo(json_mod.dumps({"action": "ban", "status": "is_favorite"}))
        else:
            notify("Wallpaper", "Can't ban a favorite")
        return

    if use_json:
        click.echo(json_mod.dumps({"action": "ban", "image": str(result.image)}))
    else:
        notify("Wallpaper", "Banned")


@cli.command()
@click.pass_context
def unban(ctx):
    """Undo the last ban."""
    config = ctx.obj["config"]
    use_json = ctx.obj["json"]

    result = do_unban(config)
    _require_success(result, use_json)

    if result.status == "nothing_to_undo":
        if use_json:
            click.echo(json_mod.dumps({"action": "unban", "status": "nothing_to_undo"}))
        else:
            notify("Wallpaper", "Nothing to undo")
        return

    if result.status == "file_missing":
        if use_json:
            click.echo(json_mod.dumps({"action": "unban", "status": "file_missing"}))
        else:
            notify("Wallpaper", "Can't restore (file missing)")
        return

    if use_json:
        click.echo(json_mod.dumps({"action": "unban", "image": str(result.image)}))
    else:
        filename = result.image.name if result.image else "unknown"
        notify("Wallpaper", f"Restored: {filename}")


@cli.command()
@click.argument("new_mode", required=False)
@click.pass_context
def mode(ctx, new_mode):
    """Show or switch purity mode.

    No argument toggles sfw/nsfw. 'sketchy' toggles sketchy on/off.
    Comma-separated values set exact combination (e.g. sfw,sketchy).
    """
    config = ctx.obj["config"]
    current = read_mode(config)

    if new_mode is None:
        result = toggle_base(current)
    elif new_mode == "sketchy":
        result = toggle_purity(current, "sketchy")
    elif "," in new_mode:
        result = {p.strip() for p in new_mode.split(",") if p.strip() in ALL_PURITIES}
        if not result:
            click.echo("Invalid mode. Use: sfw, sketchy, nsfw", err=True)
            raise SystemExit(1)
    elif new_mode in ("sfw", "nsfw"):
        result = current.copy()
        result.discard("sfw")
        result.discard("nsfw")
        result.add(new_mode)
        if not result:
            result.add(new_mode)
    else:
        click.echo(f"Unknown mode: {new_mode}. Use: sfw, sketchy, nsfw", err=True)
        raise SystemExit(1)

    write_mode(config, result)

    from .daemon import request_mode_reload

    request_mode_reload(config)

    label = ", ".join(p for p in ALL_PURITIES if p in result)
    if ctx.obj["json"]:
        click.echo(json_mod.dumps({"action": "mode", "mode": sorted(result)}))
    else:
        notify("Wallpaper", f"Mode: {label}")


@cli.command()
@click.pass_context
def status(ctx):
    """Show current wallpapers, mode, and pool counts."""
    config = ctx.obj["config"]
    snapshot = status_snapshot(config)

    if ctx.obj["json"]:
        click.echo(json_mod.dumps(snapshot, indent=2))
    else:
        mode_label = ", ".join(p for p in ALL_PURITIES if p in snapshot["mode"])
        click.echo(f"Mode: {mode_label}")
        click.echo(f"Daemon: {'running' if snapshot['daemon'] else 'stopped'}")
        click.echo(f"Disk: {snapshot['disk_mb']:.0f} MB / {snapshot['quota_mb']} MB")
        for m in snapshot["monitors"]:
            click.echo(f"  {m['name']} ({m['orientation']}): {m['image'] or 'none'}")
            click.echo(f"    Pool: {m['pool_count']}, Favorites: {m['favorites_count']}")


@cli.command()
@click.option("--ai", "use_ai", is_flag=True, help="Use Codex for intelligent analysis.")
@click.pass_context
def suggest(ctx, use_ai):
    """Show tag exclusion suggestions.

    Without --ai: shows frequency-based suggestions.
    With --ai: calls Codex CLI for semantic analysis.
    """
    config = ctx.obj["config"]
    use_json = ctx.obj["json"]

    if use_ai:
        from .ai_suggestions import AISuggestionError, generate_ai_suggestions

        try:
            result = asyncio.run(generate_ai_suggestions(config))
        except AISuggestionError as e:
            if use_json:
                click.echo(json_mod.dumps({"error": str(e)}))
            else:
                click.echo(f"Error: {e}", err=True)
            raise SystemExit(1)

        if use_json:
            click.echo(json_mod.dumps(result, ensure_ascii=False, indent=2))
        else:
            click.echo(f"\n{result['analysis']}\n")
            if result["add_suggestions"]:
                click.echo("--- Suggested Additions ---")
                for s in result["add_suggestions"]:
                    tags = " + ".join(s["tags"])
                    click.echo(f"  [{s['confidence']}] {s['type']}: {tags}")
                    click.echo(f"         {s['reason']}")
            if result["remove_suggestions"]:
                click.echo("\n--- Suggested Removals ---")
                for s in result["remove_suggestions"]:
                    tags = " + ".join(s["tags"])
                    click.echo(f"  {s['type']}: {tags}")
                    click.echo(f"         {s['reason']}")
            if not result["add_suggestions"] and not result["remove_suggestions"]:
                click.echo("No suggestions at this time.")
    else:
        from .pool import list_blacklist, load_metadata
        from .suggestions import suggest_tags_to_exclude

        metadata = load_metadata(config)
        blacklisted = {fn for _, fn in list_blacklist(config)}
        favorites = favorite_filenames(config)
        results = suggest_tags_to_exclude(
            metadata,
            blacklisted,
            config.wallhaven.exclude_tags,
            config.wallhaven.exclude_combos,
            favorites,
        )
        if use_json:
            click.echo(json_mod.dumps({"suggestions": results}, ensure_ascii=False, indent=2))
        else:
            if results:
                click.echo("Suggested exclusions (by ban frequency):")
                for s in results:
                    click.echo(
                        f"  {s['tag']} ({s['banned']}/{s['kept']}/{s['favorites']}, "
                        f"net benefit: {s['net_benefit']:g})"
                    )
            else:
                click.echo("No suggestions at this time.")


@cli.group("model")
@click.pass_context
def preference_model(ctx):
    """Train and inspect the local metadata preference model."""


@preference_model.command("train")
@click.option(
    "--combo-min-support",
    type=click.IntRange(2),
    default=20,
    show_default=True,
    help="Minimum labelled images containing a tag pair (only for experiments).",
)
@click.option(
    "--max-combos",
    type=click.IntRange(0),
    default=0,
    show_default=True,
    help="Number of pair features; 0 uses the recommended tag-only model.",
)
@click.option(
    "--validation-days",
    type=click.IntRange(0),
    default=14,
    show_default=True,
    help="Reserve this recent time window for a report-only validation pass.",
)
@click.option("--epochs", type=click.IntRange(1), default=6, show_default=True)
@click.pass_context
def train_preference_model_cmd(ctx, combo_min_support, max_combos, validation_days, epochs):
    """Train the lightweight local metadata preference model."""
    from .preference_model import (
        model_report,
        preference_learning_status,
        preference_model_path,
        train_and_save_local_preference_model,
    )

    config = ctx.obj["config"]
    try:
        model, snapshot = train_and_save_local_preference_model(
            config,
            combo_min_support=combo_min_support,
            max_combo_features=max_combos,
            validation_days=validation_days,
            epochs=epochs,
        )
        path = preference_model_path(config)
        report = model_report(
            model,
            path,
            learning=preference_learning_status(config, model, snapshot),
        )
    except (OSError, ValueError) as e:
        if ctx.obj["json"]:
            click.echo(json_mod.dumps({"error": str(e)}))
        else:
            click.echo(f"Could not train preference model: {e}", err=True)
        raise SystemExit(1) from e

    if ctx.obj["json"]:
        click.echo(json_mod.dumps(report, ensure_ascii=False, indent=2))
    else:
        training = report["training"]
        assert isinstance(training, dict)
        click.echo(f"Saved preference model: {path}")
        click.echo(
            "Training: "
            f"{training['banned']} banned, {training['retained']} retained "
            f"({training.get('controls', 0)} controls), "
            f"{training['favorites']} / {training['favorite_files']} favorites with usable metadata"
        )
        click.echo(
            f"Features: {report['tag_features']} tags, "
            f"{report.get('context_features', 0)} context, "
            f"{report['combo_features']} experimental combos"
        )
        validation = report["validation"]
        if isinstance(validation, dict) and validation.get("available"):
            click.echo(
                "Recent validation: "
                f"precision {validation.get('precision_at_threshold')}, "
                f"recall {validation.get('recall_at_threshold')} at threshold {model.threshold:.0%}"
            )
            click.echo(
                "Automatic filtering safety gate: "
                f"{'ready' if report['auto_skip_ready'] else 'not ready'}"
            )
        else:
            click.echo("Recent validation: insufficient labelled data")


@preference_model.command("refresh", hidden=True)
@click.option(
    "--download-dir",
    type=click.Path(file_okay=False, path_type=Path),
    required=True,
)
@click.option("--lease-token", required=True)
def refresh_preference_model_worker(download_dir: Path, lease_token: str):
    """Run the detached local preference-model refresh worker."""
    from .config import WayperConfig
    from .preference_model import run_scheduled_preference_model_retrain

    run_scheduled_preference_model_retrain(
        WayperConfig(download_dir=download_dir),
        lease_token,
    )


@preference_model.command("status")
@click.pass_context
def preference_model_status(ctx):
    """Show the local preference model's training and validation summary."""
    from .preference_model import (
        collect_preference_training_snapshot,
        load_preference_model,
        model_report,
        preference_learning_status,
        preference_model_path,
    )

    config = ctx.obj["config"]
    path = preference_model_path(config)
    model = load_preference_model(path)
    if not model:
        result = {"status": "untrained", "path": str(path)}
        if ctx.obj["json"]:
            click.echo(json_mod.dumps(result, ensure_ascii=False, indent=2))
        else:
            click.echo("No preference model trained yet. Run: wayper model train")
        return

    snapshot = collect_preference_training_snapshot(config)
    learning = preference_learning_status(config, model, snapshot)
    report = model_report(model, path, learning=learning)
    if ctx.obj["json"]:
        click.echo(json_mod.dumps(report, ensure_ascii=False, indent=2))
    else:
        click.echo(f"Preference model: {path}")
        training = report["training"]
        if isinstance(training, dict):
            banned = training.get("banned")
            retained = training.get("retained")
            favorites = training.get("favorites")
            favorite_files = training.get("favorite_files", favorites)
            if all(
                isinstance(value, int) for value in (banned, retained, favorites, favorite_files)
            ):
                click.echo(
                    "Training: "
                    f"{banned} banned, {retained} retained "
                    f"({training.get('controls', 0)} controls), "
                    f"{favorites} / {favorite_files} favorites with usable metadata"
                )
        click.echo(
            f"Model schema: {report.get('schema_version', 1)} "
            f"({report.get('feature_normalization', 'legacy')})"
        )
        click.echo(
            f"Features: {report['tag_features']} tags, "
            f"{report.get('context_features', 0)} context, "
            f"{report['combo_features']} experimental combos"
        )
        click.echo(f"Auto-skip threshold (not enabled by default): {model.threshold:.0%}")
        validation = report["validation"]
        if isinstance(validation, dict) and validation.get("available"):
            click.echo(
                "Recent validation: "
                f"precision {validation.get('precision_at_threshold')}, "
                f"recall {validation.get('recall_at_threshold')} at threshold {model.threshold:.0%}"
            )
        else:
            click.echo("Recent validation: insufficient labelled data")
        click.echo(
            "Automatic filtering safety gate: "
            f"{'ready' if report['auto_skip_ready'] else 'not ready'}"
        )
        if learning["stale"]:
            click.echo(
                "Online refresh: "
                f"{learning['pending_feedback']} new feedback events, "
                f"{learning['changed_examples']} changed examples "
                f"(automatic refresh at {learning['minimum_feedback']} feedback events)"
            )
        if learning.get("upgrade_due"):
            click.echo("Model refresh: v2 ranking upgrade pending")


@preference_model.command("score")
@click.argument("filename", required=False)
@click.option("--tags", default="", help="Comma-separated tags to score without a saved image.")
@click.pass_context
def preference_model_score(ctx, filename, tags):
    """Score a metadata record or ad-hoc comma-separated tags."""
    from .preference_model import load_preference_model, preference_model_path

    config = ctx.obj["config"]
    model = load_preference_model(preference_model_path(config))
    if not model:
        message = "No preference model trained yet. Run: wayper model train"
        if ctx.obj["json"]:
            click.echo(json_mod.dumps({"error": message}))
        else:
            click.echo(message, err=True)
        raise SystemExit(1)

    input_metadata = None
    if tags:
        input_tags = [tag.strip() for tag in tags.split(",") if tag.strip()]
        label = None
    elif filename:
        from .pool import load_metadata

        meta = load_metadata(config).get(filename)
        if not meta:
            message = f"No metadata found for {filename}"
            if ctx.obj["json"]:
                click.echo(json_mod.dumps({"error": message}))
            else:
                click.echo(message, err=True)
            raise SystemExit(1)
        input_tags = meta.get("tags", [])
        input_metadata = meta
        label = filename
    else:
        message = "Provide FILENAME or --tags tag1,tag2"
        if ctx.obj["json"]:
            click.echo(json_mod.dumps({"error": message}))
            raise SystemExit(2)
        raise click.UsageError(message)

    from .preference_model import auto_skip_ready

    prediction = model.predict(input_tags, metadata=input_metadata)
    safe_to_skip = auto_skip_ready(model)
    result = {
        "filename": label,
        "probability": prediction.probability,
        "calibrated": prediction.calibrated,
        "score": prediction.score,
        "feature_score": prediction.feature_score,
        "threshold": model.threshold,
        "would_skip": safe_to_skip and prediction.probability >= model.threshold,
        "contributions": list(prediction.contributions),
        "dislike_evidence": [
            item for item in prediction.contributions if item.get("direction") == "dislike"
        ],
        "keep_evidence": [
            item for item in prediction.contributions if item.get("direction") == "keep"
        ],
    }
    if ctx.obj["json"]:
        click.echo(json_mod.dumps(result, ensure_ascii=False, indent=2))
    else:
        if prediction.calibrated:
            click.echo(f"Calibrated dislike probability: {prediction.probability:.1%}")
        else:
            click.echo(f"Uncalibrated dislike score: {prediction.score:+.3f}")
        click.echo(f"Automatic skip safety gate: {'ready' if safe_to_skip else 'not ready'}")
        if prediction.contributions:
            click.echo("Top evidence:")
            for contribution in prediction.contributions:
                click.echo(
                    f"  {contribution['direction']}: {contribution['feature']} "
                    f"({contribution['weight']:+.3f})"
                )


@cli.command("update-check")
@click.option("--force", is_flag=True, help="Bypass cached update check.")
@click.pass_context
def update_check(ctx, force):
    """Check GitHub Releases for a newer Wayper version."""
    config = ctx.obj["config"]
    use_json = ctx.obj["json"]

    from .update import check_for_updates

    result = check_for_updates(config, force=force)
    if use_json:
        click.echo(json_mod.dumps(result, indent=2))
        return

    if result.get("error"):
        click.echo(f"Update check failed: {result['error']}", err=True)
        raise SystemExit(1)

    current = result["current_version"]
    latest = result.get("latest_version") or "unknown"
    if result.get("update_available"):
        click.echo(f"Wayper {latest} is available (current: {current})")
        click.echo(f"Get the update: {result['release_url']}")
    else:
        click.echo(f"Wayper is up to date ({current})")


@cli.command()
def setup():
    """Install .desktop entry (Linux)."""
    import shutil

    gui_bin = shutil.which("wayper-gui") or str(Path(sys.executable).parent / "wayper-gui")
    desktop = Path.home() / ".local/share/applications/wayper.desktop"
    desktop.parent.mkdir(parents=True, exist_ok=True)
    desktop.write_text(
        "[Desktop Entry]\n"
        "Name=Wayper\n"
        f"Exec={gui_bin}\n"
        "Icon=preferences-desktop-wallpaper\n"
        "Type=Application\n"
        "Categories=Utility;\n"
    )
    click.echo(f"Installed {desktop}")


if __name__ == "__main__":
    cli()
