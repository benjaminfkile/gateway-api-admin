import { useNavigate } from "react-router-dom";
import { Box, Button, Stack, Typography } from "@mui/material";
import HomeIcon from "@mui/icons-material/Home";

/** Fallback for any path that does not match a route inside the authed shell. */
export default function NotFoundPage() {
  const navigate = useNavigate();

  return (
    <Box sx={{ display: "flex", justifyContent: "center", mt: 8 }}>
      <Stack spacing={2} sx={{ alignItems: "center", textAlign: "center" }}>
        <Typography variant="h3" component="h1" color="text.secondary">
          404
        </Typography>
        <Typography variant="h5">Page not found</Typography>
        <Typography variant="body2" color="text.secondary">
          The page you're looking for doesn't exist or has moved.
        </Typography>
        <Button
          variant="contained"
          startIcon={<HomeIcon />}
          onClick={() => navigate("/")}
        >
          Back to Services
        </Button>
      </Stack>
    </Box>
  );
}
