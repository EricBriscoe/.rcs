local fd_opts = table.concat({
  "--color=never",
  "--type f",
  "--hidden",
  "--follow",
  "--exclude .git",
  "--exclude node_modules",
  "--exclude dist",
  "--exclude build",
  "--exclude coverage",
  "--exclude htmlcov",
  "--exclude .pytest_cache",
  "--exclude .ruff_cache",
  "--exclude __pycache__",
}, " ")

local rg_opts = table.concat({
  "--column",
  "--line-number",
  "--no-heading",
  "--color=always",
  "--smart-case",
  "--max-columns=4096",
  "--hidden",
  "--glob=!.git/*",
  "--glob=!node_modules/*",
  "--glob=!dist/*",
  "--glob=!build/*",
  "--glob=!coverage/*",
  "--glob=!htmlcov/*",
  "--glob=!.pytest_cache/*",
  "--glob=!.ruff_cache/*",
  "--glob=!__pycache__/*",
}, " ")

local function git_output(root, args)
  local cmd = { "git", "-C", root }
  vim.list_extend(cmd, args)

  local output = vim.fn.systemlist(cmd)
  if vim.v.shell_error ~= 0 then
    return nil
  end

  return output
end

local function git_first_line(root, args)
  local output = git_output(root, args)
  if not output or output[1] == "" then
    return nil
  end

  return output[1]
end

local function git_ref_exists(root, ref)
  return git_first_line(root, { "rev-parse", "--verify", "--quiet", ref }) ~= nil
end

local function current_git_root()
  return vim.fs.root(0, ".git") or vim.fs.root(vim.uv.cwd(), ".git")
end

local function mainline_ref(root)
  local origin_head = git_first_line(root, {
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  })

  local candidates = {
    origin_head,
    "origin/main",
    "origin/master",
    "upstream/main",
    "upstream/master",
    "main",
    "master",
  }

  for _, ref in ipairs(candidates) do
    if ref and git_ref_exists(root, ref) then
      return ref
    end
  end
end

local function changed_files_list()
  local root = current_git_root()
  if not root then
    vim.notify("Not inside a Git worktree", vim.log.levels.WARN)
    return nil
  end

  local base = mainline_ref(root)
  if not base then
    vim.notify("Could not find origin/main, upstream/main, main, or master", vim.log.levels.WARN)
    return nil
  end

  local files = {}
  local seen = {}

  local function append(args)
    local output = git_output(root, args)
    if not output then
      return
    end

    for _, file in ipairs(output) do
      if file ~= "" and not seen[file] then
        seen[file] = true
        files[#files + 1] = file
      end
    end
  end

  append({ "diff", "--name-only", "--diff-filter=ACMR", base .. "...HEAD" })
  append({ "diff", "--name-only", "--diff-filter=ACMR", "--cached" })
  append({ "diff", "--name-only", "--diff-filter=ACMR" })
  append({ "ls-files", "--others", "--exclude-standard" })

  return root, base, files
end

local function file_open_in_any_tab(path)
  for _, tabnr in ipairs(vim.api.nvim_list_tabpages()) do
    for _, winnr in ipairs(vim.api.nvim_tabpage_list_wins(tabnr)) do
      if vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(winnr)) == path then
        return true
      end
    end
  end
  return false
end

local function open_branch_files_in_tabs()
  local root, base, files = changed_files_list()
  if not root then
    return
  end

  if #files == 0 then
    vim.notify("No files changed against " .. base, vim.log.levels.INFO)
    return
  end

  local opened = 0
  for _, file in ipairs(files) do
    local path = root .. "/" .. file
    if not file_open_in_any_tab(path) then
      vim.cmd("tabnew " .. vim.fn.fnameescape(path))
      opened = opened + 1
    end
  end

  if opened == 0 then
    vim.notify("All " .. #files .. " changed files already have tabs", vim.log.levels.INFO)
  end
end

vim.api.nvim_create_user_command("Olc", open_branch_files_in_tabs, {
  desc = "Open each branch-changed file in its own tab",
})

-- vim user commands must be uppercase; alias :olc -> :Olc when typed as a
-- full command so the lowercase form (matching the zsh function) works too.
vim.cmd([[cnoreabbrev <expr> olc (getcmdtype() == ':' && getcmdline() ==# 'olc') ? 'Olc' : 'olc']])

local function branch_changed_files()
  local root, base, files = changed_files_list()
  if not root then
    return
  end

  if #files == 0 then
    vim.notify("No files changed against " .. base, vim.log.levels.INFO)
    return
  end

  local escaped_base = vim.fn.shellescape(base .. "...HEAD")
  local preview = table.concat({
    "git diff --color=always " .. escaped_base .. " -- {}",
    "git diff --color=always --cached -- {}",
    "git diff --color=always -- {}",
    "bat --color=always --style=numbers --line-range=:200 -- {} 2>/dev/null || sed -n '1,200p' {}",
  }, " ; ")

  local fzf = require("fzf-lua")

  fzf.fzf_exec(files, {
    cwd = root,
    preview = preview,
    prompt = "Branch files> ",
    actions = {
      ["default"] = fzf.actions.file_edit_or_qf,
      ["ctrl-s"] = fzf.actions.file_split,
      ["ctrl-v"] = fzf.actions.file_vsplit,
      ["ctrl-t"] = fzf.actions.file_tabedit,
    },
  })
end

return {
  {
    "ibhagwan/fzf-lua",
    cmd = "FzfLua",
    keys = {
      {
        "<leader><space>",
        function()
          require("fzf-lua").files()
        end,
        desc = "Find files",
      },
      {
        "<leader>sb",
        function()
          require("fzf-lua").buffers()
        end,
        desc = "Search buffers",
      },
      {
        "<leader>sc",
        function()
          require("fzf-lua").commands()
        end,
        desc = "Search commands",
      },
      {
        "<leader>se",
        branch_changed_files,
        desc = "Search branch edits",
      },
      {
        "<leader>sf",
        function()
          require("fzf-lua").files()
        end,
        desc = "Search files",
      },
      {
        "<leader>sG",
        function()
          require("fzf-lua").git_files()
        end,
        desc = "Search Git files",
      },
      {
        "<leader>sg",
        function()
          require("fzf-lua").live_grep()
        end,
        desc = "Search text",
      },
      {
        "<leader>sh",
        function()
          require("fzf-lua").help_tags()
        end,
        desc = "Search help",
      },
      {
        "<leader>sk",
        function()
          require("fzf-lua").keymaps()
        end,
        desc = "Search keymaps",
      },
      {
        "<leader>sr",
        function()
          require("fzf-lua").oldfiles()
        end,
        desc = "Search recent files",
      },
      {
        "<leader>sw",
        function()
          require("fzf-lua").grep_cword()
        end,
        desc = "Search word under cursor",
      },
    },
    opts = {
      fzf_opts = {
        ["--cycle"] = true,
        ["--info"] = "inline-right",
        ["--layout"] = "reverse",
      },
      files = {
        cwd_prompt = false,
        fd_opts = fd_opts,
        prompt = "Files> ",
      },
      grep = {
        prompt = "Grep> ",
        rg_opts = rg_opts,
      },
      oldfiles = {
        cwd_only = true,
      },
      winopts = {
        border = "rounded",
        height = 0.85,
        preview = {
          layout = "vertical",
          vertical = "down:45%",
        },
        width = 0.9,
      },
    },
  },
}
