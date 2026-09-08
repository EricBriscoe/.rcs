-- Project discovery shared by the plugin specs: git roots and worktrees,
-- mainline detection, per-root virtualenv resolution, and .env parsing.
-- Everything is derived from the filesystem so no machine-specific paths are
-- needed; worktrees of one repository resolve to the same shared venv.
local M = {}

-- Functions returning `{ name = connection_url }` tables for dadbod-ui.
-- Machine-local specs append to this list; see lua/plugins/sql.lua.
---@type (fun(ctx: { root: string?, file: string? }): table<string, string>?)[]
M.db_sources = {}

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

--- Nearest directory containing `.git` (a directory or a worktree's file).
---@param path? string|integer buffer number, path, or nil for the current buffer
---@return string?
function M.git_root(path)
  path = path or 0
  if type(path) == "number" then
    local name = vim.api.nvim_buf_get_name(path)
    path = name ~= "" and name or vim.uv.cwd()
  end
  return vim.fs.root(path, ".git")
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

--- The ref this repository's branches are compared against.
---@param root string
---@return string?
function M.mainline(root)
  local candidates = { "origin/main", "origin/master", "main", "master" }
  local head = M.git(root, { "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD" })
  if head and head[1] and head[1] ~= "" then
    table.insert(candidates, 1, head[1])
  end
  for _, ref in ipairs(candidates) do
    if ref and M.git(root, { "rev-parse", "--verify", "--quiet", ref }) then
      return ref
    end
  end
  return nil
end

--- Files touched on the current branch: committed since the mainline, staged,
--- unstaged, and untracked. Paths are relative to `root`.
---@param root string
---@return string[]? files
---@return string base_or_error
function M.branch_files(root)
  local base = M.mainline(root)
  if not base then
    return nil, "no mainline ref found (origin/HEAD, main, master)"
  end
  local seen, files = {}, {}
  -- Deleted files are left out on purpose: every consumer opens the result.
  for _, args in ipairs({
    { "diff", "--name-only", "--diff-filter=ACMR", base .. "...HEAD" },
    { "diff", "--name-only", "--diff-filter=ACMR", "--cached" },
    { "diff", "--name-only", "--diff-filter=ACMR" },
    { "ls-files", "--others", "--exclude-standard" },
  }) do
    local lines = M.git(root, args)
    if not lines then
      return nil, "git " .. table.concat(args, " ") .. " failed in " .. root
    end
    for _, file in ipairs(lines) do
      if file ~= "" and not seen[file] then
        seen[file] = true
        files[#files + 1] = file
      end
    end
  end
  return files, base
end

--- Combined diff of one file against the mainline plus local changes.
---@param root string
---@param base string
---@param file string relative path
---@return string
function M.branch_diff(root, base, file)
  local parts = {}
  for _, args in ipairs({
    { "diff", "--no-ext-diff", base .. "...HEAD", "--", file },
    { "diff", "--no-ext-diff", "--cached", "--", file },
    { "diff", "--no-ext-diff", "--", file },
  }) do
    local lines = M.git(root, args)
    if lines and #lines > 0 then
      parts[#parts + 1] = table.concat(lines, "\n")
    end
  end
  return table.concat(parts, "\n\n")
end

---@class util.project.Worktree
---@field path string
---@field branch string
---@field head? string
---@field bare? boolean

--- Every worktree of the repository containing `root`.
---@param root string
---@return util.project.Worktree[]
function M.worktrees(root)
  local list, current = {}, nil
  for _, line in ipairs(M.git(root, { "worktree", "list", "--porcelain" }) or {}) do
    local path = line:match("^worktree (.+)$")
    if path then
      current = { path = path, branch = "(detached)" }
      list[#list + 1] = current
    elseif current then
      local head = line:match("^HEAD (%x+)$")
      local branch = line:match("^branch refs/heads/(.+)$")
      if head then
        current.head = head:sub(1, 9)
      elseif branch then
        current.branch = branch
      elseif line == "bare" then
        current.bare = true
      end
    end
  end
  return list
end

--- Variables from the nearest `.env` above `path`, not looking past `root`
--- (quotes and trailing comments stripped).
---@param path string
---@param root? string
---@return table<string, string>
function M.dotenv(path, root)
  if vim.fn.isdirectory(path) == 0 then
    path = vim.fs.dirname(path)
  end
  local file = vim.fs.find(".env", {
    upward = true,
    path = path,
    type = "file",
    stop = root and vim.fs.dirname(root) or nil,
  })[1]
  local vars = {}
  if not file then
    return vars
  end
  for line in io.lines(file) do
    local key, value = line:match("^%s*export%s+([%w_]+)%s*=%s*(.-)%s*$")
    if not key then
      key, value = line:match("^%s*([%w_]+)%s*=%s*(.-)%s*$")
    end
    if key then
      if value:match('^"') or value:match("^'") then
        value = value:gsub('^"(.*)"$', "%1")
        value = value:gsub("^'(.*)'$", "%1")
      else
        -- Unquoted values may carry a trailing `# comment`.
        value = value:gsub("%s+#.*$", "")
      end
      vars[key] = value
    end
  end
  return vars
end

--- Database connections for the current buffer, merged from every source.
---@return table<string, string>
function M.dbs()
  local file = vim.api.nvim_buf_get_name(0)
  local ctx = { root = M.git_root(), file = file ~= "" and file or nil }
  local dbs = {}
  for _, source in ipairs(M.db_sources) do
    for name, url in pairs(source(ctx) or {}) do
      dbs[name] = url
    end
  end
  return dbs
end

return M
