-- Per-root virtualenv resolution for the Python spec. Everything is derived
-- from the filesystem so no machine-specific paths are needed; worktrees of
-- one repository resolve to the same shared venv.
local M = {}

---@param root string
---@param args string[]
---@return string[]? lines stdout lines, nil when git fails
function M.git(root, args)
  local cmd = { "git", "-C", root }
  vim.list_extend(cmd, args)
  local result = vim.system(cmd, { text = true }):wait()
  if result.code ~= 0 then
    return nil
  end
  return vim.split(result.stdout or "", "\n", { trimempty = true })
end

local repo_names = {} ---@type table<string, string|false>

--- Name of the main repository a checkout belongs to, derived from the git
--- common dir so every worktree of a repo gets the same answer. Cached per
--- root: it is asked for on every LSP start and formatter run.
---@param root string
---@return string?
function M.repo_name(root)
  local cached = repo_names[root]
  if cached ~= nil then
    return cached or nil
  end
  local lines = M.git(root, { "rev-parse", "--path-format=absolute", "--git-common-dir" })
  local common = lines and lines[1]
  local name = (common and common ~= "") and vim.fs.basename(vim.fs.dirname(common)) or nil
  repo_names[root] = name or false
  return name
end

--- Nearest Python project directory above `path`: a git checkout, a project
--- manifest, or a local virtualenv, whichever is closest.
---@param path string
---@return string?
function M.python_root(path)
  return vim.fs.root(path, { ".git", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", ".venv", "venv" })
end

local function has_python(dir)
  return vim.fn.executable(dir .. "/bin/python") == 1
end

--- Virtualenv for a root, in the shell's auto-activation order plus `.venv`:
--- `<root>/venv`, `<root>/.venv`, then `$WORKON_HOME/<main-repo-name>`. With
--- no root at all, the shell's `$VIRTUAL_ENV` is used; with a root it is not,
--- so a file from another project never inherits the venv nvim was started in.
---@param root? string
---@return string?
function M.venv(root)
  if not root then
    local active = vim.env.VIRTUAL_ENV
    return (active and has_python(active)) and active or nil
  end
  for _, name in ipairs({ "venv", ".venv" }) do
    local dir = root .. "/" .. name
    if has_python(dir) then
      return dir
    end
  end
  local repo = M.repo_name(root)
  if repo then
    local home = vim.env.WORKON_HOME or (vim.env.HOME .. "/.venvs")
    local dir = home .. "/" .. repo
    if has_python(dir) then
      return dir
    end
  end
  return nil
end

--- Absolute path of an executable inside the root's virtualenv, if any.
---@param root? string
---@param name string
---@return string?
function M.venv_bin(root, name)
  local venv = M.venv(root)
  if not venv then
    return nil
  end
  local bin = venv .. "/bin/" .. name
  return vim.fn.executable(bin) == 1 and bin or nil
end

return M
