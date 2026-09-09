-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua

-- Language extras: basedpyright + ruff for Python, vtsls for TypeScript.
vim.g.lazyvim_python_lsp = "basedpyright"
vim.g.lazyvim_python_ruff = "ruff"

-- Only run prettier when the project ships a prettier config; every other
-- project keeps its own formatter (biome, ruff, ...).
vim.g.lazyvim_prettier_needs_config = true

-- Prefer the git root over the LSP root, so pickers and terminals in a
-- monorepo (or a worktree of one) work from the repository, not a package.
vim.g.root_spec = { { ".git" }, "lsp", "cwd" }

-- Four-space indentation matches the tools used at work (ruff, biome,
-- sqlfluff, shfmt); Lua is set to two in autocmds.lua to match stylua.
local opt = vim.opt
opt.shiftwidth = 4
opt.tabstop = 4
opt.softtabstop = 4

vim.filetype.add({
  extension = {
    -- `.tf` defaults to TinyFugue unless content detection kicks in; nobody
    -- edits TinyFugue. OpenTofu files are Terraform.
    tf = "terraform",
    tofu = "terraform",
  },
  pattern = {
    -- Compose files are plain yaml by default; the dotted filetype is what the
    -- docker-compose language server attaches to.
    [".*/docker%-compose[^/]*%.ya?ml"] = "yaml.docker-compose",
    [".*/compose%.ya?ml"] = "yaml.docker-compose",
  },
})
