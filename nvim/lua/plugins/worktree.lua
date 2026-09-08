-- Git worktree workflow: jump between worktrees, pick the files changed on the
-- current branch with a diff preview, and load them all as buffers.
local project = require("util.project")

local title = "worktree"

--- Root, mainline ref, and changed files for the current buffer's repo.
---@return string? root
---@return string? base
---@return string[]? files
local function branch_context()
  local root = project.git_root()
  if not root then
    LazyVim.warn("Not inside a git repository", { title = title })
    return nil
  end
  local files, base = project.branch_files(root)
  if not files then
    LazyVim.warn(base, { title = title })
    return nil
  end
  if #files == 0 then
    LazyVim.info("No files changed against " .. base, { title = title })
    return nil
  end
  return root, base, files
end

local function pick_branch_edits()
  local root, base, files = branch_context()
  if not root then
    return
  end
  local items = {}
  for _, file in ipairs(files) do
    -- `file` stays relative: snacks joins it onto `cwd` itself.
    items[#items + 1] = { text = file, file = file, cwd = root, root = root, base = base }
  end
  Snacks.picker.pick({
    title = "Branch edits vs " .. base,
    items = items,
    format = "file",
    preview = function(ctx)
      local item = ctx.item
      if not item.preview then
        local diff = project.branch_diff(item.root, item.base, item.text)
        item.preview = diff ~= "" and { text = diff, ft = "diff" } or "file"
      end
      return Snacks.picker.preview.preview(ctx)
    end,
  })
end

local function pick_worktree()
  local root = project.git_root()
  if not root then
    LazyVim.warn("Not inside a git repository", { title = title })
    return
  end
  local items = {}
  for _, worktree in ipairs(project.worktrees(root)) do
    if not worktree.bare then
      items[#items + 1] = {
        text = worktree.branch .. " " .. worktree.path,
        branch = worktree.branch,
        path = worktree.path,
        current = worktree.path == root,
      }
    end
  end
  Snacks.picker.pick({
    title = "Worktrees",
    items = items,
    format = function(item)
      return {
        { item.branch, item.current and "SnacksPickerGitBranchCurrent" or "SnacksPickerGitBranch" },
        { " " },
        { vim.fn.fnamemodify(item.path, ":~"), "SnacksPickerDir" },
      }
    end,
    preview = function(ctx)
      return Snacks.picker.preview.cmd(
        { "git", "-C", ctx.item.path, "log", "--oneline", "--decorate", "-n", "30" },
        ctx
      )
    end,
    confirm = function(picker, item)
      picker:close()
      if not item then
        return
      end
      -- Let the picker finish closing before opening the next one.
      vim.schedule(function()
        vim.cmd.tcd(vim.fn.fnameescape(item.path))
        LazyVim.info(item.branch .. "\n" .. vim.fn.fnamemodify(item.path, ":~"), { title = title })
        Snacks.picker.files({ cwd = item.path })
      end)
    end,
  })
end

vim.api.nvim_create_user_command("Olc", function()
  local root, base, files = branch_context()
  if not root then
    return
  end
  for _, file in ipairs(files) do
    vim.cmd.badd(vim.fn.fnameescape(root .. "/" .. file))
  end
  vim.cmd.edit(vim.fn.fnameescape(root .. "/" .. files[1]))
  LazyVim.info(("Loaded %d files changed against %s"):format(#files, base), { title = title })
end, { desc = "Load every file changed on this branch as a buffer" })

-- User commands must be capitalised; accept the lowercase spelling the shell
-- function uses, but only when it is the whole command line.
vim.cmd([[cnoreabbrev <expr> olc (getcmdtype() == ':' && getcmdline() ==# 'olc') ? 'Olc' : 'olc']])

return {
  {
    "folke/snacks.nvim",
    keys = {
      { "<leader>gw", pick_worktree, desc = "Worktrees" },
      { "<leader>se", pick_branch_edits, desc = "Branch Edits (vs mainline)" },
    },
  },
}
