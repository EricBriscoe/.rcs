local envs_dir = vim.fn.expand("~/.claude/envs")

local function list_accounts()
  if vim.fn.isdirectory(envs_dir) == 0 then
    return {}
  end

  return vim.fn.readdir(envs_dir, function(name)
    return vim.fn.isdirectory(envs_dir .. "/" .. name) == 1 and 1 or 0
  end)
end

local function set_account(name)
  local accounts = list_accounts()
  if not vim.tbl_contains(accounts, name) then
    vim.notify(
      "Unknown Claude account: " .. name .. " (have: " .. table.concat(accounts, ", ") .. ")",
      vim.log.levels.WARN
    )
    return
  end

  vim.env.CLAUDE_CONFIG_DIR = envs_dir .. "/" .. name
  pcall(function()
    require("claudecode").stop()
  end)
  vim.notify("Claude account: " .. name)
end

return {
  {
    "coder/claudecode.nvim",
    dependencies = { "folke/snacks.nvim" },
    cmd = {
      "ClaudeCode",
      "ClaudeCodeFocus",
      "ClaudeCodeSend",
      "ClaudeCodeDiffAccept",
      "ClaudeCodeDiffDeny",
      "ClaudeAccount",
    },
    keys = {
      { "<leader>ac", "<cmd>ClaudeCode<cr>", desc = "Toggle Claude" },
      { "<leader>af", "<cmd>ClaudeCodeFocus<cr>", desc = "Focus Claude" },
      { "<leader>as", "<cmd>ClaudeCodeSend<cr>", mode = { "n", "v" }, desc = "Send to Claude" },
      { "<leader>aa", "<cmd>ClaudeCodeDiffAccept<cr>", desc = "Accept Claude diff" },
      { "<leader>ar", "<cmd>ClaudeCodeDiffDeny<cr>", desc = "Reject Claude diff" },
    },
    config = function()
      require("claudecode").setup({
        terminal_cmd = "claude",
      })

      vim.api.nvim_create_user_command("ClaudeAccount", function(opts)
        set_account(opts.args)
      end, {
        nargs = 1,
        complete = function()
          return list_accounts()
        end,
      })
    end,
  },
}
