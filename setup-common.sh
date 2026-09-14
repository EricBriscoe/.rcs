#!/usr/bin/env bash
# Shared link handling. Callers set backup_root outside the checkout.
link_resource() {
  local source="$1" destination="$2" label="$3" backup_dir previous_target
  mkdir -p "$(dirname "$destination")"
  destination="$(cd "$(dirname "$destination")" && pwd)/$(basename "$destination")"
  if [[ -L "$destination" ]] && { [[ "$(readlink "$destination")" == "$source" ]] || [[ "$destination" -ef "$source" ]]; }; then
    return
  fi
  if [[ -e "$destination" || -L "$destination" ]]; then
    mkdir -p "$backup_root"
    backup_dir="$(mktemp -d "$backup_root/$label-backup.XXXXXX")"
    previous_target=""
    if [[ -L "$destination" ]]; then
      previous_target="$(readlink "$destination")"
    fi
    if [[ -n "$previous_target" && "$previous_target" != /* ]]; then
      ln -s "$(dirname "$destination")/$previous_target" "$backup_dir/$(basename "$destination")"
      rm "$destination"
    else
      mv "$destination" "$backup_dir/$(basename "$destination")"
    fi
    printf 'Previous %s saved to %s\n' "$label" "$backup_dir"
  fi
  ln -s "$source" "$destination"
}
